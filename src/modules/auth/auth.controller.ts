import {
  Body,
  Controller,
  Get,
  GoneException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, JwtPayload } from './auth.service';
import {
  PasskeyLoginDto,
  TelegramAuthDto,
  TelegramMiniAppLoginDto,
  TelegramOidcAuthDto,
} from './dto/telegram-auth.dto';
import { UserService } from '../user/user.service';
import { SESSION_POLICY, SessionService } from './session.service';
import {
  ConditionalAuthGuard,
  type RequestWithUser,
} from './conditional-auth.guard';
import { AuthRateLimiter, AuthRateLimitedError } from './auth-rate-limiter';
import {
  LOGIN_ATTEMPT_TTL_MS,
  LoginError,
  TelegramOidcService,
} from './telegram-oidc.service';
import {
  appOrigins,
  attemptCookieName,
  cookieOptions,
  readCookie,
  sessionCookieName,
} from './cookies';
import { CurrentUser } from './user.decorator';
import { P2pService, type P2pLoginCredential } from '../p2p/p2p.service';
import { isP2pEnabled } from '../../common/p2p-enabled';
import { errorMessage } from '../../common/error-message';
import { PasskeyService } from '../passkey/passkey.service';

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface WalletLink {
  walletLinked: boolean;
  /** Only known for a new wallet: false = the bot can't message the user */
  canMessage: boolean | null;
}

/** The user app's origin: the web login returns there (APP_URL, first entry) */
const appUrl = (): string => appOrigins()[0] ?? '';

/**
 * User-app login. Each login checks the Telegram credential once, links the
 * user on the bot (its /api/v1/init, which needs that fresh credential) and
 * creates a server-side session; the credential is then dropped.
 * - web: GET telegram/start → Telegram → GET telegram/callback (cookie)
 * - Mini App: POST telegram/miniapp { initData } at launch (Bearer token)
 * Legacy JWT logins (POST telegram, telegram-oidc) answer 410 once
 * LEGACY_JWT_ISSUE=false.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
    private readonly sessions: SessionService,
    private readonly oidc: TelegramOidcService,
    private readonly p2p: P2pService,
    private readonly rateLimiter: AuthRateLimiter,
    private readonly passkeys: PasskeyService,
  ) {}

  // ---- Web: Log In with Telegram (OIDC redirect + PKCE) ----

  @Get('telegram/start')
  async telegramStart(
    @Query('return_to') returnTo: unknown,
    @Query('ref') ref: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.rateLimiter.hit('start', clientIp(req));
      const { attemptId, url } = await this.oidc.start({
        returnTo,
        referralCode: ref,
      });
      res.cookie(
        attemptCookieName(),
        attemptId,
        cookieOptions(LOGIN_ATTEMPT_TTL_MS),
      );
      res.redirect(HttpStatus.FOUND, url);
    } catch (error) {
      this.loginFailed(res, error);
    }
  }

  @Get('telegram/callback')
  async telegramCallback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const attemptId = readCookie(req, attemptCookieName());
    res.clearCookie(attemptCookieName(), cookieOptions());
    try {
      await this.rateLimiter.hit('callback', clientIp(req));
      const login = await this.oidc.callback({ attemptId, code, state, error });
      const { claims } = login;
      const telegramId = claims.id;

      await this.userService.upsertTelegramUser({
        id: telegramId,
        first_name: claims.given_name || claims.name || 'Telegram User',
        last_name: claims.family_name,
        tg_username: claims.preferred_username,
      });
      await this.userService.setTelegramSub(telegramId, claims.sub);
      await this.linkWallet(
        telegramId,
        { kind: 'idToken', value: login.idToken },
        login.referralCode,
      );

      // This browser's previous session (logging in again, maybe as another
      // account) ends here instead of idling out
      const previous = readCookie(req, sessionCookieName());
      if (previous) await this.sessions.revokeToken(previous);

      const session = await this.sessions.create(telegramId, 'web', {
        userAgent: req.header('user-agent'),
        ip: req.ip,
      });
      res.cookie(
        sessionCookieName(),
        session.token,
        cookieOptions(SESSION_POLICY.web.absoluteMs),
      );
      this.logger.log(`Web login for user ${telegramId}`);
      res.redirect(HttpStatus.FOUND, `${appUrl()}${login.returnTo}`);
    } catch (err) {
      this.loginFailed(res, err);
    }
  }

  // ---- Web: Sign in with passkey (a member who added one in settings) ----

  /** Options for the browser's passkey prompt, with the attempt to answer */
  @Post('passkey/options')
  @HttpCode(HttpStatus.OK)
  async passkeyLoginOptions(@Req() req: Request) {
    await this.rateLimiter.hit('passkey', clientIp(req));
    return this.passkeys.loginOptions();
  }

  /**
   * Check the passkey and start a web session (cookie), like the Telegram
   * web login. The session starts unlocked: the member just used their
   * passkey. No Telegram credential here, so the bot wallet link isn't
   * renewed (it lasts a year from the last Telegram login; when it has run
   * out, wallet calls answer 403 relogin_required).
   */
  @Post('passkey/login')
  @HttpCode(HttpStatus.OK)
  async passkeyLogin(
    @Body() body: PasskeyLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.rateLimiter.hit('passkey', clientIp(req));
    const telegramId = await this.passkeys.login(
      body.attempt_id,
      body.response,
    );

    // This browser's previous session ends here, as with the Telegram login
    const previous = readCookie(req, sessionCookieName());
    if (previous) await this.sessions.revokeToken(previous);
    const session = await this.sessions.create(telegramId, 'web', {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    });
    await this.sessions.markUnlocked(session.sessionId);
    res.cookie(
      sessionCookieName(),
      session.token,
      cookieOptions(SESSION_POLICY.web.absoluteMs),
    );
    this.logger.log(`Passkey web login for user ${telegramId}`);
    return { user: { telegram_id: telegramId } };
  }

  // ---- Mini App: initData exchanged once at launch ----

  @Post('telegram/miniapp')
  @HttpCode(HttpStatus.OK)
  async telegramMiniApp(
    @Body() body: TelegramMiniAppLoginDto,
    @Req() req: Request,
  ) {
    await this.rateLimiter.hit('miniapp', clientIp(req));
    const userData = this.verifiedMiniAppUser(body.initData);
    const telegramId = userData.id.toString();
    await this.rateLimiter.hit('miniappUser', telegramId);
    const isRegistered = await this.userService.userExists(telegramId);

    await this.userService.upsertTelegramUser({
      id: telegramId,
      first_name: userData.first_name || 'Telegram User',
      last_name: userData.last_name,
      tg_username: userData.username,
    });
    const link = await this.linkWallet(
      telegramId,
      { kind: 'initData', value: body.initData },
      body.referral_code ?? null,
    );
    const session = await this.sessions.create(telegramId, 'miniapp', {
      userAgent: req.header('user-agent'),
      ip: req.ip,
    });
    this.logger.log(`Mini App login for user ${telegramId}`);

    return {
      token: session.token,
      expiresAt: session.idleExpiresAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      user: { telegram_id: telegramId },
      isRegistered,
      ...link,
    };
  }

  // ---- Session ----

  @Get('me')
  @UseGuards(ConditionalAuthGuard)
  me(@CurrentUser() user: RequestWithUser['user']) {
    return {
      user: { telegram_id: user.id, username: user.username ?? null },
      session: { kind: user.sessionKind ?? 'legacy' },
    };
  }

  /** Revokes this session (this device) */
  @Post('logout')
  @UseGuards(ConditionalAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: RequestWithUser['user'],
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (user.sessionId) await this.sessions.revoke(user.sessionId);
    res.clearCookie(sessionCookieName(), cookieOptions());
  }

  /** Revokes every session of the user (all devices) */
  @Post('logout-all')
  @UseGuards(ConditionalAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @CurrentUser() user: RequestWithUser['user'],
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeAllForUser(user.id);
    res.clearCookie(sessionCookieName(), cookieOptions());
    this.logger.log(`User ${user.id} logged out of ${revoked} session(s)`);
    return { revoked };
  }

  // ---- Legacy JWT logins (until LEGACY_JWT_ISSUE=false, then 410) ----

  @Post('telegram')
  validateTelegramAuth(@Body() body: TelegramAuthDto) {
    this.assertLegacyIssuing();
    // The old app exchanged initData up to 1 h old for a 7-day JWT
    const userData = this.verifiedMiniAppUser(body.initData, 60 * 60);
    return this.legacyLogin(
      userData.id.toString(),
      userData.username,
      userData.first_name,
      userData.last_name,
    );
  }

  @Post('telegram-oidc')
  async validateTelegramOidcAuth(@Body() body: TelegramOidcAuthDto) {
    this.assertLegacyIssuing();
    const clientId = process.env.TELEGRAM_OIDC_CLIENT_ID;
    if (!clientId || !body?.id_token) {
      throw new UnauthorizedException('Invalid Telegram login data');
    }
    const claims = await this.authService.verifyTelegramOidcIdToken(
      body.id_token,
      clientId,
    );
    return this.legacyLogin(
      claims.id,
      claims.preferred_username,
      claims.given_name || claims.name,
      claims.family_name,
    );
  }

  // ---- helpers ----

  private verifiedMiniAppUser(
    initData: string,
    maxAgeSeconds?: number,
  ): TelegramUser {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      this.logger.error('Bot token not configured - authentication failed');
      throw new UnauthorizedException('Bot token not configured');
    }
    if (
      !this.authService.verifyTelegramMiniAppInitData(
        initData,
        botToken,
        maxAgeSeconds,
      )
    ) {
      throw new UnauthorizedException('Invalid Telegram init data');
    }
    const raw = this.authService.parseTelegramInitData(initData)?.user;
    try {
      const user = raw ? (JSON.parse(raw) as TelegramUser) : null;
      if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
        throw new Error('no user id');
      }
      return user;
    } catch {
      throw new UnauthorizedException('Invalid user data in init data');
    }
  }

  /**
   * Link the user on the bot with the credential we just verified, so later
   * P2P calls can name them with X-BDB-User. A bot outage must not block
   * login: the session is still created, and wallet calls answer
   * relogin_required until a later login links them.
   */
  private async linkWallet(
    telegramId: string,
    credential: P2pLoginCredential,
    referralCode: string | null,
  ): Promise<WalletLink> {
    if (!isP2pEnabled()) return { walletLinked: false, canMessage: null };
    try {
      const result = await this.p2p.init(
        telegramId,
        credential,
        referralCode ? { referral_code: referralCode } : {},
      );
      return {
        walletLinked: true,
        canMessage:
          typeof result.body.can_message === 'boolean'
            ? result.body.can_message
            : null,
      };
    } catch (error) {
      this.logger.warn(
        `Login for ${telegramId}: bot /init failed, wallet not linked (${errorMessage(error)})`,
      );
      return { walletLinked: false, canMessage: null };
    }
  }

  private loginFailed(res: Response, error: unknown): void {
    const code =
      error instanceof LoginError
        ? error.code
        : error instanceof AuthRateLimitedError
          ? 'rate_limited'
          : 'exchange_failed';
    if (
      !(error instanceof LoginError || error instanceof AuthRateLimitedError)
    ) {
      this.logger.error(`Web login failed: ${errorMessage(error)}`);
    }
    res.redirect(
      HttpStatus.FOUND,
      `${appUrl()}/?login_error=${encodeURIComponent(code)}`,
    );
  }

  private assertLegacyIssuing(): void {
    if (process.env.LEGACY_JWT_ISSUE === 'false') {
      throw new GoneException({
        code: 'login_moved',
        message: 'Please update the app and log in again.',
      });
    }
  }

  private async legacyLogin(
    telegramId: string,
    username: string | undefined,
    firstName: string | undefined,
    lastName: string | undefined,
  ) {
    const isRegistered = await this.userService.userExists(telegramId);
    await this.userService.upsertTelegramUser({
      id: telegramId,
      first_name: firstName || 'Telegram User',
      last_name: lastName,
      tg_username: username,
    });
    const payload: JwtPayload = { id: telegramId, username };
    return {
      token: this.authService.generateJwt(payload),
      user: { telegram_id: telegramId, username },
      isRegistered,
    };
  }
}

const clientIp = (req: Request): string => req.ip ?? 'unknown';
