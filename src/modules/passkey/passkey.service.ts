import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import type { Knex } from 'knex';
import { KnexService } from '../knex/knex.service';
import {
  CHALLENGE_TTL_MS,
  isSessionLocked,
  SessionService,
} from '../auth/session.service';
import type { RequestWithUser } from '../auth/conditional-auth.guard';
import { errorMessage } from '../../common/error-message';
import { relyingParty, type RelyingParty } from './passkey-config';

type RequestUser = RequestWithUser['user'];

/** A member can't have more passkeys than this */
export const MAX_PASSKEYS = 10;

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string | number;
  transports: string[] | null;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

export interface PasskeyView {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface PasskeyStatus {
  /** The member has at least one passkey (the web app locks) */
  enabled: boolean;
  /** This session may move money (always true without passkeys or in the Mini App) */
  unlocked: boolean;
  /** Passkeys work for this session (web only; Telegram's webview can't run them) */
  available: boolean;
  /**
   * The web app asks for the passkey each time it opens (the member's
   * setting: on when they add their first passkey, PATCH /passkey/settings
   * changes it). Always false without a passkey. Sends and sale payments
   * need an approval either way, and bank account changes an unlock.
   */
  lock_on_open: boolean;
  passkeys: PasskeyView[];
}

const toView = (row: PasskeyRow): PasskeyView => ({
  id: row.id,
  name: row.name,
  created_at: new Date(row.created_at).toISOString(),
  last_used_at: row.last_used_at
    ? new Date(row.last_used_at).toISOString()
    : null,
});

/**
 * The member's passkeys (WebAuthn), which lock the web/PWA app: a web
 * session of a member with one must unlock with it before money-moving
 * routes work (PasskeyUnlockedGuard). Each prompt gets a fresh challenge
 * stored on the session (single use, 5 minutes). Only public keys are
 * stored. The Mini App can't use passkeys (Telegram's webview), so it
 * neither registers nor needs them.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);

  constructor(
    private readonly knexService: KnexService,
    private readonly sessions: SessionService,
  ) {}

  private get knex() {
    return this.knexService.knex;
  }

  async status(user: RequestUser): Promise<PasskeyStatus> {
    const [rows, lockOnOpen] = await Promise.all([
      this.list(user.id),
      this.lockOnOpen(user.id),
    ]);
    return {
      enabled: rows.length > 0,
      // No passkey = never locked, even if the session was read before the
      // last one was removed
      unlocked: rows.length === 0 || user.locked !== true,
      available: user.sessionKind === 'web' && relyingParty() !== null,
      lock_on_open: rows.length > 0 && lockOnOpen,
      passkeys: rows.map(toView),
    };
  }

  /**
   * Whether the web app asks for the passkey when it opens. Turning it off
   * needs an unlocked session (like removing a passkey), so a borrowed
   * session can't switch off the prompt; turning it on doesn't. 404
   * passkey_not_set without a passkey.
   */
  async setLockOnOpen(
    user: RequestUser,
    enabled: boolean,
  ): Promise<PasskeyStatus> {
    this.webOnly(user);
    if (!enabled) this.assertUnlocked(user);
    // Under the member's user row lock, like register() and remove(): the
    // lock state read at authentication may be stale (a first passkey added
    // since then locks this session), so turning it off rechecks the session
    // as committed now
    await this.knex.transaction(async (trx) => {
      await trx('user').where('id', user.id).forNoKeyUpdate().first('id');
      const passkey = await trx('user_passkey')
        .where({ user_id: user.id })
        .first<{ id: string } | undefined>('id');
      if (!passkey) throw this.noPasskeys();
      if (!enabled) {
        const session = await trx('user_session')
          .where({ id: user.sessionId })
          .first<{ unlocked_at: Date | null } | undefined>('unlocked_at');
        if (isSessionLocked('web', true, session?.unlocked_at ?? null)) {
          throw this.locked();
        }
      }
      await trx('user')
        .where('id', user.id)
        .update({ passkey_lock_on_open: enabled });
    });
    this.logger.log(
      `Passkey lock on open turned ${enabled ? 'on' : 'off'} for user ${user.id}`,
    );
    return this.status(user);
  }

  /** Options for navigator.credentials.create() */
  async registrationOptions(
    user: RequestUser,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const rp = this.webOnly(user);
    const rows = await this.list(user.id);
    // Adding one more needs the session unlocked, or a stolen session could
    // add its own passkey and unlock with it
    if (rows.length > 0) this.assertUnlocked(user);
    if (rows.length >= MAX_PASSKEYS) throw this.limitReached();

    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      // Not the Telegram id itself: the user handle shouldn't identify them
      userID: createHash('sha256').update(`bdb-user:${user.id}`).digest(),
      userName: user.username ? `@${user.username}` : `member-${user.id}`,
      userDisplayName: user.username ? `@${user.username}` : 'Bitcoin Deepa',
      attestationType: 'none',
      excludeCredentials: rows.map((row) => ({
        id: row.credential_id,
        transports: row.transports ?? undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    await this.sessions.setChallenge(
      user.sessionId!,
      'register',
      options.challenge,
    );
    return options;
  }

  /** Store a new passkey; this session is unlocked by it */
  async register(
    user: RequestUser,
    response: RegistrationResponseJSON,
    name?: string,
  ): Promise<PasskeyStatus> {
    const rp = this.webOnly(user);
    const existing = await this.list(user.id);
    if (existing.length > 0) this.assertUnlocked(user);

    const taken = await this.sessions.takeChallenge(
      user.sessionId!,
      'register',
    );
    if (!taken) throw this.challengeExpired();

    let verified: VerifiedRegistrationResponse;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: taken.challenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.id,
        requireUserVerification: true,
      });
    } catch (error) {
      this.logger.warn(
        `Passkey registration refused for user ${user.id}: ${errorMessage(error)}`,
      );
      throw this.notVerified();
    }
    if (!verified.verified) throw this.notVerified();

    const { credential, credentialDeviceType, credentialBackedUp } =
      verified.registrationInfo;

    // One transaction per member, holding their user row: the limit and the
    // lock are checked against what's committed now (not the read above),
    // and the new passkey, locking the other sessions and unlocking this one
    // land together or not at all
    await this.knex.transaction(async (trx) => {
      await trx('user').where('id', user.id).forNoKeyUpdate().first('id');
      const [{ n }] = await trx('user_passkey')
        .where({ user_id: user.id })
        .count<{ n: string }[]>('* as n');
      const count = Number(n);
      if (count >= MAX_PASSKEYS) throw this.limitReached();
      if (count > 0) {
        const session = await trx('user_session')
          .where({ id: user.sessionId })
          .first<{ unlocked_at: Date | null } | undefined>('unlocked_at');
        if (isSessionLocked('web', true, session?.unlocked_at ?? null)) {
          throw this.locked();
        }
      }

      const inserted = await trx('user_passkey')
        .insert({
          user_id: user.id,
          credential_id: credential.id,
          public_key: Buffer.from(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ?? null,
          device_type: credentialDeviceType,
          backed_up: credentialBackedUp,
          name: name?.trim() || 'Passkey',
        })
        .onConflict('credential_id')
        .ignore()
        .returning('id');
      if (inserted.length === 0) {
        throw new BadRequestException({
          code: 'passkey_exists',
          message: 'This passkey is already registered.',
        });
      }

      // The first passkey locks every other session of the member and turns
      // the prompt on open back on (the default, whatever it was before)
      if (count === 0) {
        await this.sessions.lockOtherSessions(user.id, user.sessionId!, trx);
        await trx('user')
          .where('id', user.id)
          .update({ passkey_lock_on_open: true });
      }
      await this.sessions.markUnlocked(user.sessionId!, trx);
    });
    this.logger.log(`Passkey added for user ${user.id}`);
    return this.status({ ...user, locked: false });
  }

  /** Options for navigator.credentials.get(), to unlock the session */
  async unlockOptions(
    user: RequestUser,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return this.requestOptions(user, 'unlock');
  }

  /** Unlock this session with one of the member's passkeys */
  async unlock(
    user: RequestUser,
    response: AuthenticationResponseJSON,
  ): Promise<PasskeyStatus> {
    const rp = this.webOnly(user);
    this.credentialId(response);
    const taken = await this.sessions.takeChallenge(user.sessionId!, 'unlock');
    if (!taken) throw this.challengeExpired();
    await this.verifyAssertionAndUnlock(user, rp, taken.challenge, response);
    return this.status({ ...user, locked: false });
  }

  /**
   * Options for approving one send or sale payment. The challenge is stored
   * with the action's key, so the approval only works for that action.
   * A web member without a passkey gets 403 passkey_setup_required.
   */
  async approvalOptions(
    user: RequestUser,
    action: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return this.requestOptions(user, 'approve', action);
  }

  /**
   * Check an approval for `action` (PasskeyApprovalGuard). Single use: the
   * challenge is taken whatever happens. A good approval also unlocks the
   * session (the member just used their passkey).
   */
  async verifyApproval(
    user: RequestUser,
    action: string,
    response: AuthenticationResponseJSON,
  ): Promise<void> {
    const rp = this.webOnly(user);
    this.credentialId(response);
    const taken = await this.sessions.takeChallenge(user.sessionId!, 'approve');
    if (!taken) throw this.approvalRequired();
    if (taken.action !== action) {
      this.logger.warn(
        `Passkey approval for another action refused for user ${user.id}`,
      );
      throw this.approvalRequired();
    }
    await this.verifyAssertionAndUnlock(user, rp, taken.challenge, response);
  }

  /**
   * Whether this session must approve sends and sale payments with a
   * passkey: every web session, when the server has passkeys set up
   * (APP_URL). The Mini App can't run passkeys, so it never does.
   */
  mustApprove(user: RequestUser): boolean {
    return user.sessionKind === 'web' && relyingParty() !== null;
  }

  /** 403 passkey_setup_required when the member has no passkey */
  async assertHasPasskey(user: RequestUser): Promise<void> {
    const row = await this.knex('user_passkey')
      .where({ user_id: user.id })
      .first<{ id: string } | undefined>('id');
    if (!row) throw this.setupRequired();
  }

  private async requestOptions(
    user: RequestUser,
    kind: 'unlock' | 'approve',
    action: string | null = null,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const rp = this.webOnly(user);
    const rows = await this.list(user.id);
    if (rows.length === 0) {
      throw kind === 'approve' ? this.setupRequired() : this.noPasskeys();
    }
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      allowCredentials: rows.map((row) => ({
        id: row.credential_id,
        transports: row.transports ?? undefined,
      })),
      userVerification: 'required',
    });
    await this.sessions.setChallenge(
      user.sessionId!,
      kind,
      options.challenge,
      action,
    );
    return options;
  }

  /**
   * Verify a WebAuthn assertion by one of the member's passkeys, then bump
   * its counter and unlock this session. The last two run under the member's
   * user row lock (the one register() holds) and only if the passkey still
   * exists: one removed or replaced while the assertion was being checked
   * must not leave this session unlocked (register's first-passkey rule
   * locks the other sessions, and a late unlock would undo that).
   */
  private async verifyAssertionAndUnlock(
    user: RequestUser,
    rp: RelyingParty,
    challenge: string,
    response: AuthenticationResponseJSON,
  ): Promise<void> {
    const row = await this.knex('user_passkey')
      .where({ user_id: user.id, credential_id: this.credentialId(response) })
      .first<PasskeyRow | undefined>();
    // Someone else's passkey, or one that was removed
    if (!row) throw this.notVerified();
    await this.checkAssertion(row, rp, challenge, response, (trx) =>
      this.sessions.markUnlocked(user.sessionId!, trx),
    );
  }

  /**
   * Verify an assertion against a stored passkey, then bump its counter and
   * run `andThen` (e.g. unlock the session) in one transaction holding the
   * owner's user row (the lock register() and remove() take), and only if
   * the passkey still exists: one removed or replaced while the assertion
   * was being checked is refused (400 passkey_not_verified)
   */
  private async checkAssertion(
    row: PasskeyRow,
    rp: RelyingParty,
    challenge: string,
    response: AuthenticationResponseJSON,
    andThen?: (trx: Knex.Transaction) => Promise<void>,
  ): Promise<void> {
    let verified: VerifiedAuthenticationResponse;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.id,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: Number(row.counter),
          transports: row.transports ?? undefined,
        },
        requireUserVerification: true,
      });
    } catch (error) {
      this.logger.warn(
        `Passkey assertion refused for user ${row.user_id}: ${errorMessage(error)}`,
      );
      throw this.notVerified();
    }
    if (!verified.verified) throw this.notVerified();

    await this.knex.transaction(async (trx) => {
      await trx('user').where('id', row.user_id).forNoKeyUpdate().first('id');
      const updated = await trx('user_passkey')
        .where({ id: row.id, user_id: row.user_id })
        .update({
          // Two approvals verified side by side may finish out of order: keep
          // the highest counter (0 stays 0 for authenticators without one)
          counter: trx.raw('GREATEST(counter, ?)', [
            verified.authenticationInfo.newCounter,
          ]),
          last_used_at: new Date(),
        });
      if (updated === 0) {
        this.logger.warn(
          `Passkey assertion refused for user ${row.user_id}: the passkey was removed meanwhile`,
        );
        throw this.notVerified();
      }
      await andThen?.(trx);
    });
  }

  /**
   * Options for "Sign in with passkey" on the web login screen: no user yet,
   * so any of the member's passkeys for this site can answer (discoverable
   * credentials; the browser lists them). The challenge is stored as a
   * login attempt (5 min, single use).
   */
  async loginOptions(): Promise<{
    attempt_id: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    const rp = relyingParty();
    if (!rp) throw this.unavailable();
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      userVerification: 'required',
    });
    const [row] = await this.knex('passkey_login_attempt')
      .insert({
        challenge: options.challenge,
        expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
      })
      .returning<{ id: string }[]>('id');
    return { attempt_id: row.id, options };
  }

  /**
   * Check a login response: the attempt is taken first (single use), then
   * the passkey is found by its credential id (unique across members) and
   * its signature checked. Returns whose passkey it is.
   */
  async login(
    attemptId: string,
    response: AuthenticationResponseJSON,
  ): Promise<string> {
    const rp = relyingParty();
    if (!rp) throw this.unavailable();
    const credentialId = this.credentialId(response);
    const [attempt] = await this.knex('passkey_login_attempt')
      .where({ id: attemptId })
      .where('expires_at', '>', new Date())
      .del()
      .returning<{ challenge: string }[]>('challenge');
    if (!attempt) throw this.challengeExpired();

    const row = await this.knex('user_passkey')
      .where({ credential_id: credentialId })
      .first<PasskeyRow | undefined>();
    // A passkey we don't know (removed, or another site's)
    if (!row) throw this.notVerified();
    await this.checkAssertion(row, rp, attempt.challenge, response);
    this.logger.log(`Passkey login for user ${row.user_id}`);
    return row.user_id;
  }

  /** Remove one (an unlocked web session only); the last one turns the lock off */
  async remove(user: RequestUser, id: string): Promise<PasskeyStatus> {
    this.webOnly(user);
    this.assertUnlocked(user);
    // Under the user row lock, like register() and an unlock, so a removal
    // and an unlock with that passkey happen one after the other
    const deleted = await this.knex.transaction(
      async (trx): Promise<number> => {
        await trx('user').where('id', user.id).forNoKeyUpdate().first('id');
        return await trx('user_passkey').where({ id, user_id: user.id }).del();
      },
    );
    if (!deleted) throw new NotFoundException('Passkey not found');
    this.logger.log(`Passkey removed for user ${user.id}`);
    return this.status(user);
  }

  /**
   * Support: a member who lost their passkeys, once support has checked who
   * they are. Removes them all; returns how many.
   */
  async adminReset(userId: string): Promise<number> {
    const deleted = await this.knex('user_passkey')
      .where({ user_id: userId })
      .del();
    if (deleted) this.logger.warn(`Passkeys reset by admin for user ${userId}`);
    return deleted;
  }

  private async lockOnOpen(userId: string): Promise<boolean> {
    const row = await this.knex('user')
      .where('id', userId)
      .first<
        { passkey_lock_on_open: boolean } | undefined
      >('passkey_lock_on_open');
    return row?.passkey_lock_on_open ?? true;
  }

  private list(userId: string): Promise<PasskeyRow[]> {
    return this.knex('user_passkey')
      .where({ user_id: userId })
      .orderBy('created_at', 'asc')
      .select<PasskeyRow[]>('*');
  }

  /**
   * Passkeys need a web session (the browser's WebAuthn, our origin) and
   * APP_URL to know the origin. The Mini App gets 403 passkey_unavailable.
   */
  private webOnly(user: RequestUser): RelyingParty {
    if (user.sessionKind !== 'web' || !user.sessionId) {
      throw new ForbiddenException({
        code: 'passkey_unavailable',
        message: 'Passkeys work in the browser app, not inside Telegram.',
      });
    }
    const rp = relyingParty();
    if (!rp) {
      throw new ServiceUnavailableException({
        code: 'passkey_unavailable',
        message: 'Passkeys are not set up on this server.',
      });
    }
    return rp;
  }

  private assertUnlocked(user: RequestUser): void {
    if (user.locked) throw this.locked();
  }

  private locked() {
    return new ForbiddenException({
      code: 'passkey_required',
      message: 'Unlock with your passkey to continue.',
    });
  }

  private limitReached() {
    return new BadRequestException({
      code: 'passkey_limit',
      message: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`,
    });
  }

  /** A WebAuthn response's credential id: a nonempty string, or 400 */
  private credentialId(response: { id?: unknown } | undefined): string {
    const id = response?.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 1024) {
      throw this.notVerified();
    }
    return id;
  }

  private setupRequired() {
    return new ForbiddenException({
      code: 'passkey_setup_required',
      message: 'Set up a passkey to send or sell in the browser app.',
    });
  }

  private approvalRequired() {
    return new ForbiddenException({
      code: 'passkey_approval_required',
      message: 'Approve this with your passkey.',
    });
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'passkey_unavailable',
      message: 'Passkeys are not set up on this server.',
    });
  }

  private challengeExpired() {
    return new BadRequestException({
      code: 'challenge_expired',
      message: 'That took too long. Try again.',
    });
  }

  private notVerified() {
    return new BadRequestException({
      code: 'passkey_not_verified',
      message: "That passkey couldn't be verified. Try again.",
    });
  }

  private noPasskeys() {
    return new NotFoundException({
      code: 'passkey_not_set',
      message: "You don't have a passkey.",
    });
  }
}
