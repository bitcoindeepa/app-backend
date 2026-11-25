import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export class TelegramAuthDto {
  @IsString()
  @IsNotEmpty()
  initData: string;
}

export class TelegramOidcAuthDto {
  @IsString()
  @IsNotEmpty()
  id_token: string;
}

export class TelegramMiniAppLoginDto {
  /** The raw Telegram.WebApp.initData string (never initDataUnsafe) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(8192)
  initData: string;

  /** Recorded like a /start payload, for new bot wallets only */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
    message: 'referral_code must be 1-64 letters, digits, _ or -',
  })
  referral_code?: string;
}

/** POST /auth/passkey/login: the attempt from /auth/passkey/options and the browser's answer */
export class PasskeyLoginDto {
  @IsUUID('4')
  attempt_id!: string;

  @IsObject()
  response!: AuthenticationResponseJSON;
}
