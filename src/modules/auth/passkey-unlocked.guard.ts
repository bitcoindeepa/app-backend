import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { KnexService } from '../knex/knex.service';
import type { RequestWithUser } from './conditional-auth.guard';

export const PASSKEY_REQUIRED = 'passkey_required';

/**
 * For routes that move money or change where it goes (P2P send, paying a
 * sale, payout bank accounts): a web session of a member with a passkey
 * must have unlocked with it (POST /passkey/unlock) within UNLOCK_TTL_MS.
 * 403 passkey_required: the app shows its lock screen, then retries.
 *
 * Members without a passkey pass, and so does the Mini App: passkeys can't
 * run in Telegram's webview, so there Telegram's own app lock is the gate.
 * A legacy 7-day JWT has no session to unlock: once the member has a
 * passkey it gets 403 relogin_required. Put it after ConditionalAuthGuard.
 */
@Injectable()
export class PasskeyUnlockedGuard implements CanActivate {
  constructor(private readonly knexService: KnexService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (!user) return true;

    if (user.locked) {
      throw new ForbiddenException({
        code: PASSKEY_REQUIRED,
        message: 'Unlock with your passkey to continue.',
      });
    }

    if (user.sessionKind === 'legacy') {
      const row = await this.knexService
        .knex('user_passkey')
        .where({ user_id: user.id })
        .first<{ id: string } | undefined>('id');
      if (row) {
        throw new ForbiddenException({
          code: 'relogin_required',
          message: 'Please log in again to use your wallet.',
        });
      }
    }
    return true;
  }
}
