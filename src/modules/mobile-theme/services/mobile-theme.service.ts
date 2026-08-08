import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { UpdateMobileThemeDto } from '../dto/mobile-theme.dto';

/** The brand-token keys the broker may set. */
export const BRAND_KEYS = [
  'primary', 'accent', 'background', 'card',
  'text', 'mutedForeground', 'border', 'destructive',
] as const;
type BrandKey = (typeof BRAND_KEYS)[number];
export type ThemeColors = Partial<Record<BrandKey, string>>;

/** The default "Pine" theme — the colors the app ships with. */
export const PINE_THEME: Record<BrandKey, string> = {
  primary: '#164951',
  accent: '#45B369',
  background: '#FFFFFF',
  card: '#F9FAFB',
  text: '#111827',
  mutedForeground: '#6B7280',
  border: '#EBECEF',
  destructive: '#EF4444',
};

const SINGLETON_ID = 'default';

@Injectable()
export class MobileThemeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public: active brand overrides, or null when on the default Pine theme. */
  async getActive(): Promise<{ colors: ThemeColors | null }> {
    const row = await this.prisma.mobileTheme.findUnique({ where: { id: SINGLETON_ID } });
    return { colors: row ? (row.colors as ThemeColors) : null };
  }

  /** Admin: active overrides + the Pine defaults (for the editor's reset). */
  async getForAdmin(): Promise<{ colors: ThemeColors | null; defaults: Record<BrandKey, string> }> {
    const { colors } = await this.getActive();
    return { colors, defaults: PINE_THEME };
  }

  /** Merge a partial update onto the active theme; store only known keys. */
  async update(dto: UpdateMobileThemeDto, adminId: string): Promise<{ colors: ThemeColors }> {
    const existing = (await this.prisma.mobileTheme.findUnique({ where: { id: SINGLETON_ID } }))
      ?.colors as ThemeColors | undefined;
    const merged = this.sanitize({ ...(existing ?? {}), ...dto });

    const row = await this.prisma.mobileTheme.upsert({
      where: { id: SINGLETON_ID },
      update: { colors: merged, updatedById: adminId },
      create: { id: SINGLETON_ID, colors: merged, updatedById: adminId },
    });
    return { colors: row.colors as ThemeColors };
  }

  /** Reset to the built-in Pine theme (clears all overrides). */
  async reset(): Promise<{ colors: null; defaults: Record<BrandKey, string> }> {
    await this.prisma.mobileTheme.deleteMany({ where: { id: SINGLETON_ID } });
    return { colors: null, defaults: PINE_THEME };
  }

  private sanitize(input: Record<string, unknown>): ThemeColors {
    const out: ThemeColors = {};
    for (const key of BRAND_KEYS) {
      const v = input[key];
      if (typeof v === 'string') out[key] = v;
    }
    return out;
  }
}
