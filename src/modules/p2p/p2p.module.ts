import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PasskeyModule } from '../passkey/passkey.module';
import { TelegramLoggerModule } from '../telegram-logger/telegram-logger.module';
import { UserModule } from '../user/user.module';
import { P2pController } from './p2p.controller';
import { P2pService } from './p2p.service';
import { BitcoinPriceModule } from '../bitcoin-price/bitcoin-price.module';
import { P2pBotClient } from './p2p-bot.client';

@Module({
  imports: [
    AuthModule,
    TelegramLoggerModule,
    UserModule,
    PasskeyModule,
    BitcoinPriceModule,
  ],
  controllers: [P2pController],
  providers: [P2pService, P2pBotClient],
  exports: [P2pService],
})
export class P2pModule {}
