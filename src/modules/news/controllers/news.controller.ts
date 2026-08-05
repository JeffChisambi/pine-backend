import { Controller, Get, Param, Query, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NewsService } from '../services/news.service';
import { ListNewsQueryDto } from '../dto/news.dto';

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

  @Get(':id')
  @ApiOperation({ summary: 'Get a single published news article' })
  async get(@Param('id') id: string) {
    return this.newsService.getPublic(id);
  }
}
