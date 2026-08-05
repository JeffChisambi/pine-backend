import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../core/decorators/public.decorator';
import { NewsService } from '../services/news.service';
import { ListNewsQueryDto } from '../dto/news.dto';

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Public (mobile) news feed. Standard JWT applies (global guard) but no
 * special permission — every authenticated customer can read published news.
 * Returns items in the exact shape the mobile News tab renders.
 */
@ApiTags('news')
@Controller('news')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  @ApiOperation({ summary: 'List published news articles (mobile feed)' })
  async list(@Query() query: ListNewsQueryDto) {
    return this.newsService.listPublic(query);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List news categories that have published articles' })
  async categories() {
    return this.newsService.categories();
  }

  // ── GET /news/images/:name ────────────────────────────────────────────────
  // Public, unauthenticated image delivery: mobile <Image> components fetch
  // without auth headers. Keys are content-unique so the response is
  // immutable — cached aggressively on device and by any CDN in front.

  @Get('images/:name')
  @Public()
  @ApiOperation({ summary: 'Serve a news hero image (public, immutable-cached)' })
  async image(@Param('name') name: string, @Res() res: Response) {
    const { body, contentType, contentLength } =
      await this.newsService.getImageStream(name);
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    res.setHeader('Content-Type', contentType ?? IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream');
    if (contentLength) res.setHeader('Content-Length', String(contentLength));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    (body as NodeJS.ReadableStream).pipe(res);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single published news article' })
  async get(@Param('id') id: string) {
    return this.newsService.getPublic(id);
  }
}
