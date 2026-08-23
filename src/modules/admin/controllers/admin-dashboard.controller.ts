import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { AdminRepository } from '../repositories/admin.repository';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { BrokerScopeService } from '../../brokers/services/broker-scope.service';
import { AdminFinanceService } from '../services/admin-finance.service';

@ApiTags('admin', 'dashboard')
@ApiBearerAuth()
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly prisma: PrismaService,
    private readonly brokerScope: BrokerScopeService,
    private readonly finance: AdminFinanceService,
  ) {}

  @Get('stats')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Dashboard KPI statistics (broker admins: own broker only)',
    description: 'Returns key metrics: total users, pending KYC, today\'s trades/volume, etc.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard stats' })
  async getStats(@CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    return this.adminRepo.getDashboardStats(scope);
  }

  @Get('financials')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Financial overview (broker admins: own broker only)',
    description:
      'Client Assets (cash / portfolio market value / total), Broker Revenue ' +
      '(trading commissions), statutory levies, and Payment Costs (deposit ' +
      'processing fees) — each derived independently from transactional data.',
  })
  @ApiResponse({ status: 200, description: 'Financial overview' })
  async getFinancials(@CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    return this.finance.brokerFinancials(scope);
  }

  @Get('reconciliation')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Wallet ↔ ledger reconciliation (broker admins: own broker only)',
    description:
      'Compares every wallet balance against its double-entry ledger sum. ' +
      'Any discrepancy is listed and also surfaced into System Errors.',
  })
  @ApiResponse({ status: 200, description: 'Reconciliation result' })
  async getReconciliation(@CurrentUser() admin: AuthenticatedUser) {
    const scope = await this.brokerScope.resolveScope(admin);
    return this.finance.reconcile(scope);
  }

  @Get('charts')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Dashboard chart data (broker admins: own broker only)',
    description: 'Time-series data for volume, revenue, deposits/withdrawals over N days.',
  })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Chart data array' })
  async getChartData(@CurrentUser() admin: AuthenticatedUser, @Query('days') days?: string) {
    const parsedDays = days ? parseInt(days, 10) : 14;
    const scope = await this.brokerScope.resolveScope(admin);
    return this.adminRepo.getChartData(parsedDays, scope);
  }

  @Get('health')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'System health status',
    description: 'Database connectivity, Redis ping, queue depths.',
  })
  @ApiResponse({ status: 200, description: 'Health check results' })
  async getHealth() {
    const checks: Record<string, { status: string; latencyMs?: number; queueDepth?: number; failedCount?: number }> = {};

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
        // queueDepth/failedCount are the meaningful metrics here.
        // Previously this incorrectly stuffed the queue count into latencyMs,
        // which is a timing field — monitoring tools would misinterpret it.
        queueDepth: pendingNotifications,
        failedCount: failedNotifications,
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
