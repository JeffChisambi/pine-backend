import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { SystemErrorService } from './services/system-error.service';
import { ErrorReportController } from './controllers/error-report.controller';
import { AdminErrorsController } from './controllers/admin-errors.controller';

/**
 * System error monitoring — captures errors from every surface (mobile app,
 * broker/admin dashboards, and the backend itself) into one console so
 * platform admins see problems before users report them.
 *
 * Global: the exception filter and any service can inject SystemErrorService
 * to record backend-side failures without importing this module.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [ErrorReportController, AdminErrorsController],
  providers: [SystemErrorService],
  exports: [SystemErrorService],
})
export class SystemErrorsModule {}
