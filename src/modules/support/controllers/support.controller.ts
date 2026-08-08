import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';
import { SupportService, type AttachmentInput } from '../services/support.service';
import { CreateSupportTicketDto, ReplySupportTicketDto } from '../dto/support.dto';

/**
 * SupportController — customer "Help & Support / Report a problem" endpoints.
 *
 *   POST /v1/support               → open a ticket (optional screenshot)
 *   GET  /v1/support               → my tickets
 *   GET  /v1/support/:id           → a ticket thread
 *   POST /v1/support/:id/messages  → reply to a ticket (optional screenshot)
 */
@ApiTags('support')
@ApiBearerAuth()
@Controller('support')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('attachment', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiOperation({ summary: 'Open a new support ticket' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSupportTicketDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.supportService.createTicket(user.id, dto, toAttachment(file));
  }

  @Get()
  @ApiOperation({ summary: "List the authenticated user's support tickets" })
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.supportService.listUserTickets(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a support ticket thread' })
  async thread(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.supportService.getUserThread(user.id, id);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('attachment', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiOperation({ summary: 'Reply to a support ticket' })
  async reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReplySupportTicketDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.supportService.addUserMessage(user.id, id, dto, toAttachment(file));
  }
}

function toAttachment(file?: Express.Multer.File): AttachmentInput | undefined {
  if (!file) return undefined;
  return { originalName: file.originalname, mimeType: file.mimetype, buffer: file.buffer };
}
