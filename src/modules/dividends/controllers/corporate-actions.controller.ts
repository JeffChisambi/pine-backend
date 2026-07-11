import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { CorporateActionsService } from '../services/corporate-actions.service';
import { CorporateActionsQueryDto } from '../dto/corporate-actions.dto';

/**
 * Corporate Actions Controller — user-facing endpoints.
 *
 * Lists dividends, splits, bonus issues, and rights issues.
 * Admin endpoints (declare, process) are in the Admin module.
 *
 * Endpoints:
 *   GET /v1/corporate-actions                → All actions (paginated)
 *   GET /v1/corporate-actions/:id            → Action detail
 *   GET /v1/corporate-actions/dividends      → Dividends list
 *   GET /v1/corporate-actions/dividends/:id  → Dividend detail
 *   GET /v1/corporate-actions/history        → User's action history
 */
@ApiTags('corporate-actions')
@ApiBearerAuth()
@Controller('corporate-actions')
export class CorporateActionsController {
  constructor(
    private readonly corporateActionsService: CorporateActionsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List corporate actions',
    description:
      'Returns paginated corporate actions (dividends, splits, bonus, rights). ' +
      'Optionally filter by stock.',
  })
  @ApiResponse({ status: 200, description: 'Corporate actions list' })
  async getCorporateActions(@Query() query: CorporateActionsQueryDto) {
    return this.corporateActionsService.getCorporateActions(
      query.stockId,
      query.limit ?? 30,
      query.offset ?? 0,
    );
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get user corporate action history',
    description:
      'Returns the authenticated user\'s dividend distributions and ' +
      'other corporate action history.',
  })
  @ApiResponse({ status: 200, description: 'User action history' })
  async getUserHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: number,
  ) {
    return this.corporateActionsService.getUserHistory(user.id, limit ?? 30);
  }

  @Get('dividends')
  @ApiOperation({
    summary: 'List dividends',
    description: 'Returns all declared dividends, optionally filtered by stock.',
  })
  @ApiResponse({ status: 200, description: 'Dividends list' })
  async getDividends(
    @Query('stockId') stockId?: string,
    @Query('limit') limit?: number,
  ) {
    return this.corporateActionsService.getDividends(stockId, limit ?? 30);
  }

  @Get('dividends/:id')
  @ApiOperation({
    summary: 'Get dividend detail',
    description: 'Returns full detail for a specific dividend.',
  })
  @ApiParam({ name: 'id', description: 'Dividend UUID' })
  @ApiResponse({ status: 200, description: 'Dividend detail' })
  async getDividendById(@Param('id') id: string) {
    return this.corporateActionsService.getDividendById(id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get corporate action detail',
    description:
      'Returns full detail for a corporate action including its ' +
      'type-specific data (dividend amounts, split ratios, etc.).',
  })
  @ApiParam({ name: 'id', description: 'Corporate action UUID' })
  @ApiResponse({ status: 200, description: 'Corporate action detail' })
  async getCorporateActionById(@Param('id') id: string) {
    return this.corporateActionsService.getCorporateActionById(id);
  }
}
