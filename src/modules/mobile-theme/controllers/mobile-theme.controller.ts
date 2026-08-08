import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../core/decorators/public.decorator';
import { MobileThemeService } from '../services/mobile-theme.service';

/**
 * Public mobile theme endpoint. The app fetches this at launch (before login,
 * so the auth screens theme too) to apply the broker's brand colors.
 *
 *   GET /v1/mobile-theme → { colors: {...} | null }
 */
@ApiTags('mobile-theme')
@Controller('mobile-theme')
export class MobileThemeController {
  constructor(private readonly service: MobileThemeService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Get the active mobile brand theme (public)' })
  async get() {
    return this.service.getActive();
  }
}
