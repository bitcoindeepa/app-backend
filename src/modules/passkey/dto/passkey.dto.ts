import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

// The WebAuthn responses are checked by @simplewebauthn/server, not here:
// these only make sure an object was sent.

export class RegisterPasskeyDto {
  @IsObject()
  response!: RegistrationResponseJSON;

  /** Shown in settings, e.g. "iPhone"; defaults to "Passkey" */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @Matches(/^[^\p{C}]+$/u, { message: 'name has invalid characters' })
  name?: string;
}

export class UnlockDto {
  @IsObject()
  response!: AuthenticationResponseJSON;
}

/**
 * The action an approval is for: a send (same fields as POST /p2p/send) or
 * a sale payment (POST /sell/orders/:id/pay)
 */
export class ApprovalOptionsDto {
  @IsIn(['p2p_send', 'sell_pay'])
  action!: 'p2p_send' | 'sell_pay';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  to_telegram_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsString()
  @Length(1, 128)
  idempotency_key?: string;

  @IsOptional()
  @IsUUID('4')
  order_id?: string;
}
