import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuditModule } from '../audit/audit.module';
import { AdminPointsController } from './controllers/admin-points.controller';
import { PointsController } from './controllers/points.controller';
import { AdminPointsService } from './services/admin-points.service';
import { ClaimsService } from './services/claims.service';
import { LeaderboardService } from './services/leaderboard.service';
import { MilestoneService } from './services/milestone.service';
import { PointsAwardService } from './services/points-award.service';
import { PointsListenerService } from './services/points-listener.service';
import { PointsMaintenanceService } from './services/points-maintenance.service';
import { PointsRulesService } from './services/points-rules.service';
import { PointsService } from './services/points.service';
import { SeasonService } from './services/season.service';

/**
 * Pine Points — the practice app's leaderboard competition.
 *
 * The module is always imported, but only wires itself up when POINTS_ENABLED
 * and VIRTUAL_TRADING are both on. On a real-money instance it registers no
 * controllers, binds no event handlers and schedules no jobs, so the routes
 * genuinely do not exist rather than existing and refusing. That is what lets
 * the whole feature live on `main` without a branch that slowly rots.
 *
 * It imports neither the wallet nor the trading module: everything it learns
 * about the platform arrives on the event bus, which is this codebase's rule
 * for cross-module work.
 */
const enabled =
  process.env.POINTS_ENABLED === 'true' && process.env.VIRTUAL_TRADING === 'true';

@Module({
  imports: [DatabaseModule, ConfigModule, AuditModule],
  controllers: enabled ? [PointsController, AdminPointsController] : [],
  providers: enabled
    ? [
        SeasonService,
        PointsAwardService,
        LeaderboardService,
        MilestoneService,
        ClaimsService,
        PointsRulesService,
        PointsService,
        AdminPointsService,
        PointsListenerService,
        PointsMaintenanceService,
      ]
    : [],
  exports: enabled ? [PointsAwardService, SeasonService] : [],
})
export class PointsModule {}
