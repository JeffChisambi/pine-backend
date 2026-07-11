import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { StocksRepository } from './repositories/stocks.repository';
import { StocksService } from './services/stocks.service';
import { StocksController } from './controllers/stocks.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [StocksController],
  providers: [StocksRepository, StocksService],
  exports: [StocksService],
})
export class StocksModule {}
