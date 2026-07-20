import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { WatchlistRepository } from './repositories/watchlist.repository';
import { WatchlistService } from './services/watchlist.service';
import { WatchlistController } from './controllers/watchlist.controller';
import { StocksModule } from '../stocks/stocks.module';

@Module({
  imports: [DatabaseModule, StocksModule],
  controllers: [WatchlistController],
  providers: [WatchlistRepository, WatchlistService],
  exports: [WatchlistService],
})
export class WatchlistModule {}
