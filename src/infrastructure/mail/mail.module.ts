import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { MailService } from './mail.service';

/**
 * Global mail module — transactional SMTP email (OTP codes, alerts).
 * Global so auth/notifications can inject MailService without re-importing.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
