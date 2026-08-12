import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { AppConfigService } from '../../../config/app-config.service';
import {
  ResourceNotFoundException,
  ValidationException,
} from '../../../core/exceptions/app.exception';
import { CreateNewsDto, ListNewsQueryDto, UpdateNewsDto } from '../dto/news.dto';

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Shape the mobile app consumes — must match app/(tabs)/news.tsx NewsItem. */
export interface PublicNewsItem {
  id: string;
  category: string;
  title: string;
  summary: string | null;
  body: string[];
  /** Pre-formatted display string, e.g. "30 Mar 2026". */
  time: string;
  source: string;
  /** Hero image URL (string) — mobile's imgSrc() handles URI strings. */
  image: string | null;
  featured: boolean;
}

@Injectable()
export class NewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
  ) {}

  // ── Images ───────────────────────────────────────────────────────────────

  /**
   * Store a news hero image and return its permanent, public URL.
   * Images live in the avatars bucket under a `news/` prefix (content-unique
   * key), served via GET /v1/news/images/:name with immutable cache headers —
   * safe to cache forever on devices and any CDN in front.
   */
  async uploadImage(fileName: string, mimeType: string, buffer: Buffer) {
    const ext = ALLOWED_IMAGE_TYPES[mimeType];
    if (!ext) {
      throw new ValidationException(
        `Unsupported image type ${mimeType}. Use JPEG, PNG, WebP or GIF.`,
      );
    }
    const { key } = await this.storage.upload({
      bucket: 'avatars',
      keyPrefix: 'news',
      fileName: `${randomUUID()}.${ext}`,
      contentType: mimeType,
      body: buffer,
    });
    // key = news/<timestamp>-<uuid>-<uuid>.<ext>; the public route addresses
    // it by basename (no slashes — traversal-safe by construction).
    const name = key.slice('news/'.length);
    return { imageUrl: `${this.apiBase()}/v1/news/images/${name}`, key };
  }

  /**
   * APP_URL normalized for URL building: no trailing slash, and a trailing
   * "/v1" is stripped so a misconfigured APP_URL=https://host/v1 cannot
   * produce ".../v1/v1/news/images/…" URLs.
   */
  private apiBase(): string {
    return this.config.app.url.replace(/\/$/, '').replace(/\/v1$/, '');
  }

  /**
   * Normalize a stored image URL at READ time.
   *
   * Image URLs used to be frozen into the row at upload time from APP_URL —
   * which on deployments where APP_URL was left at its localhost default
   * produced permanently broken "http://localhost:3000/…" URLs on real
   * devices. Rows can't be trusted, so the host is re-derived from the
   * current APP_URL on every read: any URL that points at the app's own
   * news-image route (absolute with any host, or relative) is rebuilt as
   * `${APP_URL}/v1/news/images/<name>`. URLs that are NOT ours (externally
   * scraped article images) are passed through untouched.
   */
  private publicImageUrl(stored: string | null): string | null {
    if (!stored) return null;
    const match = stored.match(/\/v1\/news\/images\/([^/?#\s]+)$/);
    if (!match) return stored; // external image — leave as-is
    return `${this.apiBase()}/v1/news/images/${match[1]}`;
  }

  /** Stream a stored news image for the public route. */
  async getImageStream(name: string) {
    // Only the exact generated shape is accepted — no slashes, no traversal.
    if (!/^[0-9]+-[a-f0-9-]{36}-[a-f0-9-]{36}\.(jpg|png|webp|gif)$/i.test(name)) {
      throw new ResourceNotFoundException('Image', name);
    }
    try {
      return await this.storage.getObjectStream('avatars', `news/${name}`);
    } catch {
      throw new ResourceNotFoundException('Image', name);
    }
  }

  // ── Public (mobile) ──────────────────────────────────────────────────────

  /**
   * Published articles, newest first, featured floated to the top.
   * Returned in the exact shape the mobile News tab renders.
   */
  async listPublic(query: ListNewsQueryDto): Promise<PublicNewsItem[]> {
    const where: Record<string, unknown> = { isPublished: true };
    if (query.category && query.category.toLowerCase() !== 'all') {
      where.category = query.category;
    }

    const articles = await this.prisma.newsArticle.findMany({
      where,
      orderBy: [{ featured: 'desc' }, { publishedAt: 'desc' }],
      take: Math.min(query.limit ?? 50, 100),
      skip: ((query.page ?? 1) - 1) * (query.limit ?? 50),
    });

    return articles.map((a) => this.toPublic(a));
  }

  async getPublic(id: string): Promise<PublicNewsItem> {
    const article = await this.prisma.newsArticle.findFirst({
      where: { id, isPublished: true },
    });
    if (!article) throw new ResourceNotFoundException('News article', id);
    return this.toPublic(article);
  }

  /** Distinct category names that currently have published articles. */
  async categories(): Promise<string[]> {
    const rows = await this.prisma.newsArticle.findMany({
      where: { isPublished: true },
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });
    return rows.map((r) => r.category);
  }

  // ── Admin (dashboard) ────────────────────────────────────────────────────

  /** Full list including drafts, newest edited first — for the CMS table. */
  async listAdmin(query: ListNewsQueryDto) {
    const where: Record<string, unknown> = {};
    if (query.category && query.category.toLowerCase() !== 'all') {
      where.category = query.category;
    }
    if (!query.includeUnpublished) {
      // Admin list defaults to showing everything; only filter if asked.
    }
    const limit = Math.min(query.limit ?? 50, 100);
    const page = query.page ?? 1;

    const [articles, total] = await Promise.all([
      this.prisma.newsArticle.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.newsArticle.count({ where }),
    ]);

    return {
      articles: articles.map((a) => ({
        ...a,
        imageUrl: this.publicImageUrl(a.imageUrl),
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getAdmin(id: string) {
    const article = await this.prisma.newsArticle.findUnique({ where: { id } });
    if (!article) throw new ResourceNotFoundException('News article', id);
    return { ...article, imageUrl: this.publicImageUrl(article.imageUrl) };
  }

  async create(dto: CreateNewsDto, authorId: string) {
    return this.prisma.newsArticle.create({
      data: {
        category: dto.category,
        title: dto.title,
        summary: dto.summary ?? null,
        body: this.cleanBody(dto.body),
        source: dto.source,
        imageUrl: dto.imageUrl ?? null,
        featured: dto.featured ?? false,
        isPublished: dto.isPublished ?? true,
        publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : new Date(),
        authorId,
      },
    });
  }

  async update(id: string, dto: UpdateNewsDto) {
    await this.getAdmin(id); // 404 if missing
    return this.prisma.newsArticle.update({
      where: { id },
      data: {
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
        ...(dto.body !== undefined ? { body: this.cleanBody(dto.body) } : {}),
        ...(dto.source !== undefined ? { source: dto.source } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
        ...(dto.featured !== undefined ? { featured: dto.featured } : {}),
        ...(dto.isPublished !== undefined ? { isPublished: dto.isPublished } : {}),
        ...(dto.publishedAt !== undefined ? { publishedAt: new Date(dto.publishedAt) } : {}),
      },
    });
  }

  async remove(id: string) {
    await this.getAdmin(id);
    await this.prisma.newsArticle.delete({ where: { id } });
    return { message: 'News article deleted', id };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private cleanBody(body: string[]): string[] {
    return (body ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  }

  private toPublic(a: {
    id: string; category: string; title: string; summary: string | null;
    body: string[]; source: string; imageUrl: string | null;
    featured: boolean; publishedAt: Date;
  }): PublicNewsItem {
    return {
      id: a.id,
      category: a.category,
      title: a.title,
      summary: a.summary,
      body: a.body ?? [],
      time: this.formatDate(a.publishedAt),
      source: a.source,
      image: this.publicImageUrl(a.imageUrl),
      featured: a.featured,
    };
  }

  /** "30 Mar 2026" — matches the mobile's pre-formatted `time` strings. */
  private formatDate(date: Date): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }
}
