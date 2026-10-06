import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { NewsController } from './controllers/news.controller';
import { AdminNewsController } from './controllers/admin-news.controller';
import { NewsService } from './services/news.service';
import { MseNewsSyncService } from './services/mse-news-sync.service';

/**
 * News module — editorial articles surfaced in the mobile News tab.
 *   - NewsController      → public/mobile read (published only)
 *   - AdminNewsController → dashboard CRUD (ADMIN_ACCESS, audited)
 *   - MseNewsSyncService  → weekly import from the MSE website (MSE_NEWS_SYNC)
 */
@Module({
  imports: [DatabaseModule, ConfigModule, AuditModule, StorageModule],
  controllers: [NewsController, AdminNewsController],
  providers: [NewsService, MseNewsSyncService],
  exports: [NewsService],
})
export class NewsModule {}
