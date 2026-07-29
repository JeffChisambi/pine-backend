import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { TreasuryService } from '../services/treasury.service';
import { InvestDto } from '../dto/treasury.dto';

/**
 * TreasuryController — T-bill investment endpoints.
 *
 *   GET  /v1/treasury/products         → list available T-bill products
 *   GET  /v1/treasury/investments      → user's active investments
 *   POST /v1/treasury/invest           → submit a new investment
 *   GET  /v1/treasury/investments/:id  → single investment status
 */
@ApiTags('treasury')
@ApiBearerAuth()
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  // ── Products ─────────────────────────────────────────────────

  @Get('products')
  @ApiOperation({ summary: 'List available T-bill products' })
  @ApiResponse({ status: 200, description: 'Array of available treasury products' })
  async getProducts() {
    return this.treasuryService.getProducts();
  }

  // ── Investments ──────────────────────────────────────────────

  @Get('investments')
  @ApiOperation({ summary: "List the authenticated user's T-bill investments" })
  @ApiResponse({ status: 200, description: 'Array of treasury investments' })
  async getUserInvestments(@CurrentUser() user: AuthenticatedUser) {
    return this.treasuryService.getUserInvestments(user.id);
  }

  @Post('invest')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a new T-bill investment order' })
  @ApiResponse({ status: 201, description: 'Investment created' })
  @ApiResponse({ status: 400, description: 'Invalid amount or product unavailable' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async invest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InvestDto,
  ) {
    return this.treasuryService.invest(user.id, dto.productId, dto.amount);
  }

  @Get('investments/:id')
  @ApiOperation({ summary: 'Fetch status and details of a specific investment' })
  @ApiParam({ name: 'id', description: 'Investment UUID' })
  @ApiResponse({ status: 200, description: 'Investment details' })
  @ApiResponse({ status: 404, description: 'Investment not found' })
  async getInvestment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') investmentId: string,
  ) {
    return this.treasuryService.getInvestmentById(user.id, investmentId);
  }
}
