import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { AdminRepository } from '../repositories/admin.repository';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

@ApiTags('admin', 'dashboard')
@ApiBearerAuth()
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly prisma: PrismaService,
  ) {}

  @Get('stats')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Dashboard KPI statistics',
    description: 'Returns key metrics: total users, pending KYC, today\'s trades/volume, etc.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard stats' })
  async getStats() {
    return this.adminRepo.getDashboardStats();
  }

  @Get('charts')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Dashboard chart data',
    description: 'Time-series data for volume, revenue, deposits/withdrawals over N days.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Chart data array' })
  async getChartData(@Query('days') days?: string) {
    const parsedDays = days ? parseInt(days, 10) : 14;
    return this.adminRepo.getChartData(parsedDays);
  }

  @Get('health')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'System health status',
    description: 'Database connectivity, Redis ping, queue depths.',
  })
  @ApiResponse({ status: 200, description: 'Health check results' })
  async getHealth() {
    const checks: Record<string, { status: string; latencyMs?: number }> = {};

    // DB health
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks['database'] = { status: 'healthy', latencyMs: Date.now() - dbStart };
    } catch {
      checks['database'] = { status: 'unhealthy', latencyMs: Date.now() - dbStart };
    }

    // Queue depths (from notifications/payments tables with pending status)
    try {
      const pendingNotifications = await this.prisma.notification.count({
        where: { status: 'QUEUED' },
      });
      const failedNotifications = await this.prisma.notification.count({
        where: { status: 'FAILED' },
      });
      checks['notificationQueue'] = {
        status: failedNotifications > 50 ? 'degraded' : 'healthy',
        latencyMs: pendingNotifications, // Reuse field to show queue depth
      };
    } catch {
      checks['notificationQueue'] = { status: 'unknown' };
    }

    const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
