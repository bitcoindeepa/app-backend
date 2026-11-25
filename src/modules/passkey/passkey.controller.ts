import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ConditionalAuthGuard,
  type RequestWithUser,
} from '../auth/conditional-auth.guard';
import { SessionRequiredGuard } from '../auth/session-required.guard';
import { AdminKeyGuard } from '../auth/admin-key.guard';
import { CurrentUser } from '../auth/user.decorator';
import { errorMessage } from '../../common/error-message';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import {
  ApprovalOptionsDto,
  RegisterPasskeyDto,
  UnlockDto,
} from './dto/passkey.dto';
import { approvalKey } from './approval-action';
import { PasskeyService } from './passkey.service';

type RequestUser = RequestWithUser['user'];

/**
 * The member's passkeys, which lock the web/PWA app. Errors carry a `code`:
 * passkey_unavailable (403 in the Mini App, 503 without APP_URL),
 * passkey_required (403: unlock first), challenge_expired (400: ask for new
 * options), passkey_not_verified (400), passkey_exists (400),
 * passkey_limit (400), passkey_not_set (404), passkey_setup_required (403:
 * a web member needs one to send or sell), passkey_approval_required (403).
 * Never 401 for a failed passkey: the app treats 401 as "signed out".
 * A legacy JWT can't use these (403 relogin_required).
 */
@Controller('passkey')
export class PasskeyController {
  private readonly logger = new Logger(PasskeyController.name);

  constructor(
    private readonly passkeys: PasskeyService,
    private readonly telegramLogger: TelegramLoggerService,
  ) {}

  @Get()
  @UseGuards(ConditionalAuthGuard, SessionRequiredGuard)
  status(@CurrentUser() user: RequestUser) {
    return this.passkeys.status(user);
  }

  @Post('register/options')
  @UseGuards(ConditionalAuthGuard, SessionRequiredGuard)
  @HttpCode(HttpStatus.OK)
  registrationOptions(@CurrentUser() user: RequestUser) {
    return this.passkeys.registrationOptions(user);
  }

  /** Add a passkey; this session is unlocked, the member's other web sessions lock */
  @Post('register')
  @UseGuards(ConditionalAuthGuard, SessionRequiredGuard)
  @HttpCode(HttpStatus.OK)
  async register(
    @CurrentUser() user: RequestUser,
    @Body() body: RegisterPasskeyDto,
  ) {
    const status = await this.passkeys.register(user, body.response, body.name);
    this.logAction('🔐 Passkey added', user);
    return status;
  }

  @Post('unlock/options')
  @UseGuards(ConditionalAuthGuard, SessionRequiredGuard)
  @HttpCode(HttpStatus.OK)
  unlockOptions(@CurrentUser() user: RequestUser) {
    return this.passkeys.unlockOptions(user);
  }

  /** Unlock this session */
  @Post('unlock')
  @UseGuards(ConditionalAuthGuard, SessionRequiredGuard)
  @HttpCode(HttpStatus.OK)
  unlock(@CurrentUser() user: RequestUser, @Body() body: UnlockDto) {
    return this.passkeys.unlock(user, body.response);
  }

  /**
   * Options to approve one send or sale payment (web). The approval goes
   * with that request in X-Passkey-Assertion and works for it only.
   */
  @Post('approve/options')
  @UseGuards(ConditionalAuthGuard, SessionRequiredGuard)
  @HttpCode(HttpStatus.OK)
  approvalOptions(
    @CurrentUser() user: RequestUser,
    @Body() body: ApprovalOptionsDto,
  ) {
    const action = approvalKey(body.action, body);
    if (!action) {
      throw new BadRequestException(
        body.action === 'p2p_send'
          ? 'to_telegram_id, amount and idempotency_key are required'
          : 'order_id is required',
      );
    }
    return this.passkeys.approvalOptions(user, action);
  }

  /** Remove one (needs an unlocked web session); removing the last turns the lock off */
  @Delete(':id')
  @UseGuards(ConditionalAuthGuard, SessionRequiredGuard)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const status = await this.passkeys.remove(user, id);
    this.logAction('🔐 Passkey removed', user);
    return status;
  }

  /**
   * Support (x-admin-key): remove all of a member's passkeys once they've
   * proven who they are (lost phone). 404 when they have none.
   */
  @Post('admin-reset/:userId')
  @UseGuards(AdminKeyGuard)
  @HttpCode(HttpStatus.OK)
  async adminReset(@Param('userId') userId: string) {
    const removed = await this.passkeys.adminReset(userId);
    if (!removed) throw new NotFoundException('No passkeys for this user');
    return { removed };
  }

  /**
   * Ops log after the change is done, without waiting for Telegram: a slow
   * or failing Telegram call never delays or fails the passkey request
   */
  private logAction(action: string, user: RequestUser): void {
    void this.telegramLogger
      .logGenericAction(action, user)
      .catch((error: unknown) =>
        this.logger.warn(`Telegram log failed: ${errorMessage(error)}`),
      );
  }
}
