import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { SystemErrorService } from '../services/system-error.service';

class ReportErrorDto {
  @IsIn(['MOBILE_APP', 'BROKER_DASHBOARD', 'ADMIN_DASHBOARD'])
  source!: 'MOBILE_APP' | 'BROKER_DASHBOARD' | 'ADMIN_DASHBOARD';

  @IsIn(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
  severity!: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

  @IsString()
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  stack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  location?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

/**
 * Client error ingestion — the mobile app and both dashboards POST their
 * unhandled errors here so admins see problems before users report them.
 * Requires a valid JWT (any role). Tightly rate-limited: a crash loop on
 * one device must not flood the API.
 */
@ApiTags('errors')
@Controller('errors')
export class ErrorReportController {
  constructor(private readonly errors: SystemErrorService) {}

  @Post('report')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Report a client-side error for the admin console' })
  @ApiResponse({ status: 202, description: 'Error recorded' })
  async report(@Body() dto: ReportErrorDto, @CurrentUser() user: AuthenticatedUser) {
    await this.errors.capture({
      source: dto.source,
      severity: dto.severity,
      message: dto.message,
      stack: dto.stack,
      location: dto.location,
      context: dto.context,
      userId: user?.id ?? null,
    });
    return { accepted: true };
  }
}
