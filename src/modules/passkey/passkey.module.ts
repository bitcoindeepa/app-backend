import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { PasskeyController } from './passkey.controller';
import { PasskeyService } from './passkey.service';

@Module({
  imports: [AuthModule, TelegramLoggerModule],
  controllers: [PasskeyController],
  providers: [PasskeyService],
})
export class PasskeyModule {}
