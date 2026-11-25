import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { KnexService } from '../knex/knex.service';
import type { JwtPayload } from './auth.service';

export type SessionKind = 'web' | 'miniapp';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Per kind: idle timeout (slides while the user is active), hard limit from
 * creation, and how often activity is written (at most once per touchEvery,
 * so a busy user doesn't update their row on every request).
 * Both stay well under the bot's 1-year X-BDB-User link, which every login
 * renews.
 */
export const SESSION_POLICY: Record<
  SessionKind,
  { idleMs: number; absoluteMs: number; touchEveryMs: number }
> = {
  web: { idleMs: 30 * DAY, absoluteMs: 180 * DAY, touchEveryMs: DAY },
  miniapp: { idleMs: DAY, absoluteMs: 7 * DAY, touchEveryMs: HOUR },
};

export interface SessionUser extends JwtPayload {
  sessionId: string;
  sessionKind: SessionKind;
  /**
   * A web session of a member with a passkey that hasn't unlocked with it
   * (or not within UNLOCK_TTL_MS). PasskeyUnlockedGuard refuses
   * money-moving routes while it's true. Never true for the Mini App, where
   * passkeys can't run (Telegram's webview).
   */
  locked: boolean;
}

/** How long an unlocked web session may move money before unlocking again */
export const UNLOCK_TTL_MS = 12 * HOUR;

/** Whether a session is locked, from its kind and when it last unlocked */
export const isSessionLocked = (
  kind: SessionKind,
  hasPasskey: boolean,
  unlockedAt: Date | string | null,
  now = Date.now(),
): boolean =>
  kind === 'web' &&
  hasPasskey &&
  (!unlockedAt || now - new Date(unlockedAt).getTime() > UNLOCK_TTL_MS);

export type ChallengeKind = 'register' | 'unlock';

/** A pending WebAuthn challenge lives this long (the browser prompt's timeout) */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface CreatedSession {
  token: string;
  sessionId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  kind: SessionKind;
  last_seen_at: Date;
  absolute_expires_at: Date;
  username: string | null;
  tg_username: string | null;
  unlocked_at: Date | null;
  has_passkey: boolean;
}

export const hashToken = (token: string): Buffer =>
  createHash('sha256').update(token).digest();

/** 32 random bytes, base64url: 43 chars, never contains '.' (legacy JWTs do) */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const looksLikeSessionToken = (token: string): boolean =>
  TOKEN_PATTERN.test(token);

/**
 * Server-side sessions for the user app. The token is 32 random bytes handed
 * to the client once (cookie on the web, response body in the Mini App); only
 * its SHA-256 is stored, so a DB leak doesn't leak usable tokens.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly knexService: KnexService) {}

  private get knex() {
    return this.knexService.knex;
  }

  async create(
    userId: string,
    kind: SessionKind,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<CreatedSession> {
    const policy = SESSION_POLICY[kind];
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + policy.absoluteMs);
    const idleExpiresAt = new Date(
      Math.min(now + policy.idleMs, absoluteExpiresAt.getTime()),
    );
    const [row] = await this.knex('user_session')
      .insert({
        user_id: userId,
        token_hash: hashToken(token),
        kind,
        idle_expires_at: idleExpiresAt,
        absolute_expires_at: absoluteExpiresAt,
        user_agent: meta.userAgent?.slice(0, 512) ?? null,
        ip: meta.ip?.slice(0, 64) ?? null,
      })
      .returning<{ id: string }[]>('id');
    return { token, sessionId: row.id, idleExpiresAt, absoluteExpiresAt };
  }

  /**
   * The session's user, or null when the token is unknown, revoked or
   * expired. Slides the idle timeout (capped at the hard limit) at most once
   * per touchEvery.
   */
  async validate(token: string): Promise<SessionUser | null> {
    if (!looksLikeSessionToken(token)) return null;
    const now = new Date();
    const row = await this.knex('user_session as s')
      .join('user as u', 'u.id', 's.user_id')
      .where('s.token_hash', hashToken(token))
      .whereNull('s.revoked_at')
      .where('s.idle_expires_at', '>', now)
      .where('s.absolute_expires_at', '>', now)
      .first<
        SessionRow | undefined
      >('s.id', 's.user_id', 's.kind', 's.last_seen_at', 's.absolute_expires_at', 'u.username', 'u.tg_username', 's.unlocked_at', this.knex.raw('exists (select 1 from user_passkey p where p.user_id = s.user_id) as has_passkey'));
    if (!row) return null;

    const policy = SESSION_POLICY[row.kind];
    if (
      now.getTime() - new Date(row.last_seen_at).getTime() >=
      policy.touchEveryMs
    ) {
      const idle = new Date(
        Math.min(
          now.getTime() + policy.idleMs,
          new Date(row.absolute_expires_at).getTime(),
        ),
      );
      // Conditional on last_seen_at, so concurrent requests write once
      await this.knex('user_session')
        .where({ id: row.id, last_seen_at: row.last_seen_at })
        .update({ last_seen_at: now, idle_expires_at: idle })
        .catch((error: unknown) =>
          this.logger.warn(`Session touch failed: ${String(error)}`),
        );
    }

    return {
      id: row.user_id,
      username: row.username ?? undefined,
      tgUsername: row.tg_username ?? undefined,
      sessionId: row.id,
      sessionKind: row.kind,
      locked: isSessionLocked(
        row.kind,
        row.has_passkey,
        row.unlocked_at,
        now.getTime(),
      ),
    };
  }

  /** This session just unlocked with a passkey */
  async markUnlocked(sessionId: string): Promise<void> {
    await this.knex('user_session')
      .where({ id: sessionId })
      .update({ unlocked_at: new Date() });
  }

  /**
   * Lock every other session of the user (their first passkey: a session
   * unlocked under an earlier, since removed passkey mustn't stay unlocked)
   */
  async lockOtherSessions(
    userId: string,
    exceptSessionId: string,
  ): Promise<void> {
    await this.knex('user_session')
      .where({ user_id: userId })
      .whereNot({ id: exceptSessionId })
      .whereNotNull('unlocked_at')
      .update({ unlocked_at: null });
  }

  /**
   * Remember the session's pending WebAuthn challenge (replaces any earlier
   * one: only the latest prompt can complete)
   */
  async setChallenge(
    sessionId: string,
    kind: ChallengeKind,
    challenge: string,
  ): Promise<void> {
    await this.knex('user_session')
      .where({ id: sessionId })
      .update({
        webauthn_challenge: challenge,
        webauthn_challenge_kind: kind,
        webauthn_challenge_expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
      });
  }

  /**
   * Take the session's pending challenge of this kind, if it hasn't
   * expired. Single use: it's cleared in the same statement, so a response
   * can't be replayed and two requests can't both use it.
   */
  async takeChallenge(
    sessionId: string,
    kind: ChallengeKind,
  ): Promise<string | null> {
    // RETURNING shows the new (null) value, so read the old one through a
    // locked subquery
    const result = await this.knex.raw<{ rows: { challenge: string }[] }>(
      `UPDATE user_session s
          SET webauthn_challenge = NULL,
              webauthn_challenge_kind = NULL,
              webauthn_challenge_expires_at = NULL
         FROM (SELECT id, webauthn_challenge FROM user_session
                WHERE id = ? FOR UPDATE) old
        WHERE s.id = old.id
          AND s.webauthn_challenge_kind = ?
          AND s.webauthn_challenge IS NOT NULL
          AND s.webauthn_challenge_expires_at > now()
    RETURNING old.webauthn_challenge AS challenge`,
      [sessionId, kind],
    );
    return result.rows[0]?.challenge ?? null;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.knex('user_session')
      .where({ id: sessionId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
  }

  /** End the session a token names, if any (a browser logging in again) */
  async revokeToken(token: string): Promise<void> {
    if (!looksLikeSessionToken(token)) return;
    await this.knex('user_session')
      .where({ token_hash: hashToken(token) })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
  }

  /** Every session of the user (all devices); returns how many */
  async revokeAllForUser(userId: string): Promise<number> {
    return this.knex('user_session')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
  }

  /**
   * Housekeeping: expired sessions, sessions revoked more than a week ago
   * and expired login attempts.
   */
  async deleteExpired(): Promise<{ sessions: number; attempts: number }> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const sessions = await this.knex('user_session')
      .where('idle_expires_at', '<', now)
      .orWhere('absolute_expires_at', '<', now)
      .orWhere('revoked_at', '<', weekAgo)
      .del();
    const attempts = await this.knex('telegram_login_attempt')
      .where('expires_at', '<', now)
      .del();
    return { sessions, attempts };
  }
}
