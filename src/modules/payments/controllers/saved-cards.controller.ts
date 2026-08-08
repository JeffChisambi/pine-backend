import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { SavedCardService } from '../services/saved-card.service';
import { SaveCardDto } from '../dto/saved-card.dto';

@ApiTags('cards')
@ApiBearerAuth()
@Controller('cards')
export class SavedCardsController {
  constructor(private readonly savedCardService: SavedCardService) {}

  @Get()
  @ApiOperation({ summary: 'List saved cards for the authenticated user' })
  @ApiResponse({ status: 200, description: 'List of saved cards' })
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.savedCardService.listCards(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Save a new card' })
  @ApiResponse({ status: 201, description: 'Card saved' })
  async save(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SaveCardDto,
  ) {
    return this.savedCardService.saveCard(user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a saved card' })
  @ApiResponse({ status: 200, description: 'Card deleted' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.savedCardService.deleteCard(user.id, id);
    return { success: true };
  }

  @Patch(':id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a card as the default' })
  @ApiResponse({ status: 200, description: 'Default card updated' })
  async setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.savedCardService.setDefault(user.id, id);
    return { success: true };
  }
}
