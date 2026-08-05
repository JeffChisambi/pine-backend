import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';
import { AuditModule } from '../audit/audit.module';
import { NewsController } from './controllers/news.controller';
import { AdminNewsController } from './controllers/admin-news.controller';
import { NewsService } from './services/news.service';

/**
 * News module — editorial articles surfaced in the mobile News tab.
 *   - NewsController      → public/mobile read (published only)
 *   - AdminNewsController → dashboard CRUD (ADMIN_ACCESS, audited)
 */
@Module({
  imports: [DatabaseModule, ConfigModule, AuditModule],
  controllers: [NewsController, AdminNewsController],
  providers: [NewsService],
  exports: [NewsService],
})
export class NewsModule {}
