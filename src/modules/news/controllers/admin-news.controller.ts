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
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AuditLogService } from '../../audit/services/audit-log.service';
import { NewsService } from '../services/news.service';
import { CreateNewsDto, ListNewsQueryDto, UpdateNewsDto } from '../dto/news.dto';
import { ValidationException } from '../../../core/exceptions/app.exception';

/**
 * Admin (dashboard) news management. Requires PLATFORM_ADMIN — Super Admin only (platform-wide content)
 * that can reach the dashboard can manage news — and audits every mutation,
 * matching the admin-notifications / admin-users convention.
 */
@ApiTags('admin', 'news')
@ApiBearerAuth()
@Controller('admin/news')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AdminNewsController {
  constructor(
    private readonly newsService: NewsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'List all news articles (incl. drafts) for the CMS' })
  async list(@Query() query: ListNewsQueryDto) {
    return this.newsService.listAdmin(query);
  }

  // ── POST /admin/news/upload-image ─────────────────────────────────────────
  // Upload a hero image; returns a permanent public URL served by the backend
  // (GET /v1/news/images/:name) with immutable cache headers.

  @Post('upload-image')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a news hero image (max 5 MB, image types only)' })
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    if (!file) throw new ValidationException('No file provided');
    const result = await this.newsService.uploadImage(
      file.originalname,
      file.mimetype,
      file.buffer,
    );
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'NEWS_IMAGE_UPLOADED',
      resourceType: 'NEWS_ARTICLE',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { fileName: file.originalname, size: file.size },
    });
    return result;
  }

  @Get(':id')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Get a single news article for editing' })
  async get(@Param('id') id: string) {
    return this.newsService.getAdmin(id);
  }

  @Post()
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a news article' })
  async create(
    @Body() dto: CreateNewsDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const article = await this.newsService.create(dto, admin.id);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'NEWS_CREATED',
      resourceType: 'NEWS_ARTICLE',
      resourceId: article.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { title: article.title, published: article.isPublished },
    });
    return article;
  }

  @Patch(':id')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a news article' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateNewsDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const article = await this.newsService.update(id, dto);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'NEWS_UPDATED',
      resourceType: 'NEWS_ARTICLE',
      resourceId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { published: article.isPublished },
    });
    return article;
  }

  @Delete(':id')
  @RequirePermissions(Permission.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a news article' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const result = await this.newsService.remove(id);
    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'NEWS_DELETED',
      resourceType: 'NEWS_ARTICLE',
      resourceId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return result;
  }
}
