import {
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
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
