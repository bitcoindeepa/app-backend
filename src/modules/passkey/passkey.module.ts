import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { PasskeyController } from './passkey.controller';
import { PasskeyService } from './passkey.service';
import { PasskeyApprovalGuard } from './passkey-approval.guard';

@Module({
  imports: [AuthModule, TelegramLoggerModule],
  controllers: [PasskeyController],
  providers: [PasskeyService, PasskeyApprovalGuard],
  exports: [PasskeyService, PasskeyApprovalGuard],
})
export class PasskeyModule {}
