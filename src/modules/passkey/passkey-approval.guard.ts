import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { RequestWithUser } from '../auth/conditional-auth.guard';
import { PasskeyService } from './passkey.service';
import {
  APPROVAL_HEADER,
  approvalKey,
  type ApprovalInput,
  type ApprovalKind,
} from './approval-action';

const APPROVAL_KIND = 'passkey_approval_kind';

/** Which action a route's passkey approval is for (see PasskeyApprovalGuard) */
export const RequirePasskeyApproval = (kind: ApprovalKind) =>
  SetMetadata(APPROVAL_KIND, kind);

/**
 * Mandatory passkey approval for each send and sale payment from the web
 * app: the request carries a WebAuthn assertion (header
 * X-Passkey-Assertion) answering a challenge issued for exactly this action
 * (POST /passkey/approve/options). 403 passkey_setup_required without a
 * passkey, 403 passkey_approval_required without (or with someone else's,
 * or a used) approval, 400 passkey_not_verified for a bad one.
 *
 * Mini App sessions pass: passkeys can't run in Telegram's webview. Put it
 * after ConditionalAuthGuard and SessionRequiredGuard (a legacy JWT never
 * gets here). Reads the raw body, before validation, to rebuild the key.
 */
@Injectable()
export class PasskeyApprovalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly passkeys: PasskeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.get<ApprovalKind | undefined>(
      APPROVAL_KIND,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const { user } = request;
    if (!kind || !user || !this.passkeys.mustApprove(user)) return true;

    const body = (request.body ?? {}) as ApprovalInput;
    const action = approvalKey(kind, {
      ...body,
      order_id: request.params?.id,
    });
    const header = request.header(APPROVAL_HEADER);
    if (!action || !header) {
      // Tells the app whether to offer setup or a passkey prompt
      await this.passkeys.assertHasPasskey(user);
      throw new ForbiddenException({
        code: 'passkey_approval_required',
        message: 'Approve this with your passkey.',
      });
    }

    let response: AuthenticationResponseJSON;
    try {
      response = JSON.parse(
        Buffer.from(header, 'base64url').toString('utf8'),
      ) as AuthenticationResponseJSON;
    } catch {
      throw new ForbiddenException({
        code: 'passkey_approval_required',
        message: 'Approve this with your passkey.',
      });
    }
    await this.passkeys.verifyApproval(user, action, response);
    request.user = { ...user, locked: false };
    return true;
  }
}
