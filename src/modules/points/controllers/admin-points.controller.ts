import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { Permission } from '../../auth/constants/permissions.constant';
import { AdjustPointsDto, AdminLeaderboardQueryDto } from '../dto/points.dto';
import { AdminPointsService } from '../services/admin-points.service';

/**
 * The prize-awarding view.
 *
 * Unmasked on purpose: picking winners needs real names and contacts, which
 * is exactly why reading it is audited as well as the mutations. Restricted
 * to PLATFORM_ADMIN rather than any staff role, because the board spans every
 * broker and a broker admin must not enumerate another broker's investors.
 */
@ApiTags('admin', 'points')
@ApiBearerAuth()
@Controller('admin/points')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AdminPointsController {
  constructor(
    private readonly admin: AdminPointsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get('leaderboard')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'The board with real identities, for settling prizes',
    description:
      'Flags anyone whose score leans overwhelmingly on a single rule, which ' +
      'is the shape point farming takes.',
  })
  async leaderboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AdminLeaderboardQueryDto,
    @Req() req: RequestWithUser,
  ) {
    const result = await this.admin.leaderboard(query);
    // Reading the ranking before a payout is itself a sensitive act.
    await this.audit.log({
      actorId: user.id,
      actorRole: user.role,
      action: 'points.leaderboard.viewed',
      resourceType: 'CompetitionSeason',
      resourceId: result.season?.slug,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { page: query.page ?? 1, search: query.search },
    });
    return result;
  }

  @Get('users/:userId')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Everything one person has earned, including refused claims',
    description: 'The forensics view for a disputed prize.',
  })
  async user(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.admin.userDetail(userId);
  }

  @Post('users/:userId/adjust')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Correct someone’s points by hand',
    description:
      'The only path that writes a negative row, so the ledger stays ' +
      'append-only while remaining correctable. Always audited.',
  })
  async adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdjustPointsDto,
    @Req() req: RequestWithUser,
  ) {
    const result = await this.admin.adjust(userId, dto.points, dto.reason);
    await this.audit.log({
      actorId: user.id,
      actorRole: user.role,
      action: 'points.adjusted',
      resourceType: 'User',
      resourceId: userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { points: dto.points, reason: dto.reason, newTotal: result.newTotal },
    });
    return result;
  }
}
