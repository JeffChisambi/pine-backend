import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import {
  CompareClaimDto,
  HistoryQueryDto,
  LeaderboardQueryDto,
  LessonClaimDto,
  NotificationOpenClaimDto,
  RulesQueryDto,
} from '../dto/points.dto';
import { ClaimsService } from '../services/claims.service';
import { PointsService } from '../services/points.service';

/**
 * The Board tab's surface. Every route is an ordinary authenticated customer
 * route — the global JWT guard applies and no extra permission is needed.
 *
 * The whole controller only exists on a practice instance: the module does
 * not register it otherwise, so these paths 404 on the real platform rather
 * than existing and refusing.
 */
@ApiTags('points')
@ApiBearerAuth()
@Controller('points')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class PointsController {
  constructor(
    private readonly points: PointsService,
    private readonly claims: ClaimsService,
  ) {}

  @Get('rules')
  @ApiOperation({
    summary: 'How to earn points, the season and the prizes',
    description:
      'Everything the earn screen renders, including the caller’s own progress ' +
      'against each rule. The app holds no points values of its own.',
  })
  async rules(@CurrentUser() user: AuthenticatedUser, @Query() query: RulesQueryDto) {
    return this.points.rules(user.id, query.lang ?? 'en');
  }

  @Get('leaderboard')
  @ApiOperation({
    summary: 'A page of the board, plus where the caller sits',
    description:
      'The `me` block is always present, even when the caller is far outside ' +
      'the page, so nobody has to scroll to find themselves.',
  })
  async leaderboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LeaderboardQueryDto,
  ) {
    return this.points.leaderboard(user.id, query);
  }

  @Get('me')
  @ApiOperation({ summary: 'The caller’s points, rank, streak and next milestone' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.points.summary(user.id);
  }

  @Get('me/rank')
  @ApiOperation({ summary: 'Just the rank — the cheapest call, for polling after a claim' })
  async myRank(@CurrentUser() user: AuthenticatedUser) {
    return this.points.rank(user.id);
  }

  @Get('me/history')
  @ApiOperation({ summary: 'What the caller has earned, newest first' })
  async history(@CurrentUser() user: AuthenticatedUser, @Query() query: HistoryQueryDto) {
    return this.points.history(user.id, query.limit ?? 20, query.offset ?? 0);
  }

  // ── Claims ────────────────────────────────────────────────────────────────
  // Things the platform cannot observe for itself. Each one names something
  // that happened; the server decides whether it did and whether it has
  // already been paid for. 200 rather than 201 throughout: "I considered your
  // claim" is the semantic, and a refusal is a normal answer, not an error.

  @Post('claims/notification-open')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Claim for opening an alert promptly',
    description:
      'Send only the notification id. The server times the gap from its own ' +
      'delivery record, so the device clock plays no part.',
  })
  @ApiResponse({ status: 200, description: 'Claim considered; see `awarded`' })
  @ApiResponse({ status: 404, description: 'No such notification for this user' })
  async notificationOpen(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: NotificationOpenClaimDto,
  ) {
    return this.claims.notificationOpened(user.id, dto.notificationId);
  }

  @Post('claims/lesson')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a finished lesson',
    description:
      'Also returns every lesson this user has finished, which is how a ' +
      'reinstalled app recovers progress that used to live only on the device.',
  })
  async lesson(@CurrentUser() user: AuthenticatedUser, @Body() dto: LessonClaimDto) {
    return this.claims.lessonCompleted(user.id, dto.lessonId);
  }

  @Post('claims/compare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Claim for comparing two stocks' })
  async compare(@CurrentUser() user: AuthenticatedUser, @Body() dto: CompareClaimDto) {
    return this.claims.compareUsed(user.id, dto.symbolA, dto.symbolB);
  }

  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check in for today',
    description:
      'The day is the server’s, in Malawi time, so changing the device ' +
      'timezone cannot roll the streak forward.',
  })
  async checkIn(@CurrentUser() user: AuthenticatedUser) {
    return this.claims.checkIn(user.id);
  }

  @Get('lessons')
  @ApiOperation({ summary: 'Lessons this user has finished, for restoring progress' })
  async lessons(@CurrentUser() user: AuthenticatedUser) {
    return this.points.lessons(user.id);
  }
}
