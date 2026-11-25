import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { AuthController } from './auth.controller';
import { AuthRateLimiter } from './auth-rate-limiter';
import { TelegramOidcService } from './telegram-oidc.service';
import { SessionCleanupService } from './session-cleanup.service';
import { UserModule } from '../user/user.module';
import { P2pModule } from '../p2p/p2p.module';
import { PasskeyModule } from '../passkey/passkey.module';

/** The user-app login routes (/auth/*): web OIDC, passkey, Mini App, logout */
@Module({
  imports: [AuthModule, UserModule, P2pModule, PasskeyModule],
  controllers: [AuthController],
  providers: [TelegramOidcService, AuthRateLimiter, SessionCleanupService],
})
export class LoginModule {}
