import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { appConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * Imports news from the Malawi Stock Exchange website, weekly.
 *
 * The MSE publishes three lists worth reading:
 *
 *   - corporate announcements: dividends, board changes, cautionaries. Each
 *     is a PDF, and most are typed rather than scanned, so their text comes
 *     out cleanly and becomes the article body.
 *   - financial results: also PDFs, but made of statement tables. Their text
 *     is a wall of figures, so these get a short written summary instead and
 *     a link to the statements.
 *   - "MSE News": the exchange's own items. Each detail page is only a title,
 *     a picture and a download, so the article is the picture and a line.
 *
 * Every article keeps the address of its original, which is unique in the
 * table. That is the whole dedupe story: the sync can read the same listings
 * every week and only what is new gets inserted.
 *
 * Off unless MSE_NEWS_SYNC=true, so the real-money app keeps its hand-written
 * news. Parsing is regex over the MSE's markup; if they redesign the site the
 * sync finds nothing and logs it, rather than publishing rubbish.
 */

const BASE = 'https://mse.co.mw';
const LISTS = {
  corporate: `${BASE}/announcements/corporate`,
  accounts: `${BASE}/announcements/accounts`,
  market: `${BASE}/announcements/market`,
} as const;

/** How far back a normal weekly run looks. Overlap is free: the dedupe absorbs it. */
const WEEKLY_LOOKBACK_DAYS = 21;
/** How far back the first run reaches, so the section is not empty on day one. */
const BACKFILL_LOOKBACK_DAYS = 45;
/** Never pull more than this many PDFs in one run. */
const MAX_ITEMS_PER_RUN = 40;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;
const USER_AGENT = 'PineNewsBot/1.0 (+https://appine.online)';

type Kind = 'corporate' | 'accounts' | 'market';

interface ListingItem {
  kind: Kind;
  title: string;
  company: string | null;
  date: Date;
  url: string;
  imageUrl: string | null;
}

interface StockRef {
  symbol: string;
  name: string;
  sector: string;
  key: string;
}

export interface SyncSummary {
  ran: boolean;
  reason?: string;
  seen: number;
  inWindow: number;
  created: number;
  skippedExisting: number;
  failed: number;
}

@Injectable()
export class MseNewsSyncService implements OnModuleInit {
  private readonly logger = new Logger(MseNewsSyncService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  /**
   * On a fresh install the section would sit empty until next Monday, so if
   * nothing has ever been imported, backfill once. Delayed so it never slows
   * the server coming up.
   */
  onModuleInit(): void {
    if (!this.app.mseNewsSync) return;
    setTimeout(() => {
      this.prisma.newsArticle
        .count({ where: { origin: 'mse' } })
        .then((n) => (n === 0 ? this.sync(BACKFILL_LOOKBACK_DAYS) : null))
        .catch((e: unknown) => this.logger.error({ err: e }, 'MSE news backfill failed'));
    }, 30_000);
  }

  /** Mondays at 06:00 Malawi time, before anyone opens the app that week. */
  @Cron('0 6 * * 1', { name: 'mse-news-sync', timeZone: 'Africa/Blantyre' })
  async weekly(): Promise<void> {
    if (!this.app.mseNewsSync) return;
    try {
      await this.sync(WEEKLY_LOOKBACK_DAYS);
    } catch (error) {
      this.logger.error({ err: error }, 'Weekly MSE news sync failed');
    }
  }

  async sync(lookbackDays = WEEKLY_LOOKBACK_DAYS): Promise<SyncSummary> {
    const empty = { seen: 0, inWindow: 0, created: 0, skippedExisting: 0, failed: 0 };
    if (!this.app.mseNewsSync) return { ran: false, reason: 'disabled', ...empty };
    if (this.running) return { ran: false, reason: 'already running', ...empty };
    this.running = true;

    try {
      const since = new Date(Date.now() - lookbackDays * 86_400_000);
      const listings = (
        await Promise.all(
          (Object.keys(LISTS) as Kind[]).map((k) =>
            this.readListing(k).catch((e: unknown) => {
              this.logger.warn({ err: e, list: k }, 'Could not read an MSE listing');
              return [] as ListingItem[];
            }),
          ),
        )
      ).flat();

      const inWindow = listings
        .filter((i) => i.date >= since)
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, MAX_ITEMS_PER_RUN);

      const existing = new Set(
        (
          await this.prisma.newsArticle.findMany({
            where: { sourceUrl: { in: inWindow.map((i) => i.url) } },
            select: { sourceUrl: true },
          })
        ).map((r) => r.sourceUrl),
      );

      const stocks = await this.stockIndex();
      let created = 0;
      let failed = 0;

      for (const item of inWindow) {
        if (existing.has(item.url)) continue;
        try {
          const article = await this.toArticle(item, stocks);
          await this.prisma.newsArticle.create({ data: article });
          created += 1;
        } catch (error) {
          // A duplicate here means another run beat us to it; anything else is
          // one bad document, which must not stop the rest.
          failed += 1;
          this.logger.warn({ err: error, url: item.url }, 'Skipped an MSE item');
        }
      }

      const summary: SyncSummary = {
        ran: true,
        seen: listings.length,
        inWindow: inWindow.length,
        created,
        skippedExisting: existing.size,
        failed,
      };
      if (listings.length === 0) {
        this.logger.error('MSE news sync read no listings at all — has the site changed?');
      } else {
        this.logger.log(summary, 'MSE news sync finished');
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  // ── Reading the listings ──────────────────────────────────────────────────

  private async readListing(kind: Kind): Promise<ListingItem[]> {
    const html = await this.fetchText(LISTS[kind]);
    return kind === 'market' ? this.parseMarketCards(html) : this.parseTableRows(kind, html);
  }

  /** Corporate notices and results: one table row per document. */
  private parseTableRows(kind: 'corporate' | 'accounts', html: string): ListingItem[] {
    const items: ListingItem[] = [];
    const linkRe = new RegExp(`https://mse\\.co\\.mw/announcements/${kind}/(\\d+)`);
    for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const link = row.match(linkRe);
      if (!link) continue;
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) ?? [])
        .map((c) => clean(c))
        .filter((c) => c && !/^download$/i.test(c));
      // title, company, date — in that order on both lists.
      const date = cells.map(parseDate).find((d): d is Date => d !== null);
      if (!date || cells.length < 2) continue;
      items.push({
        kind,
        title: cells[0],
        company: cells[1] ?? null,
        date,
        url: link[0],
        imageUrl: null,
      });
    }
    return items;
  }

  /** "MSE News": cards with a picture, a title and a date. */
  private parseMarketCards(html: string): ListingItem[] {
    const items: ListingItem[] = [];
    const cards = html.split(/<div class="card news-card/i).slice(1);
    for (const card of cards) {
      const link = card.match(/https:\/\/mse\.co\.mw\/announcements\/market\/\d+/);
      const title = card.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
      const date = card.match(/class="date">([^<]+)</i);
      const img = card.match(/<img[^>]+src="([^"]+)"/i);
      const when = date ? parseDate(date[1]) : null;
      if (!link || !title || !when) continue;
      items.push({
        kind: 'market',
        title: clean(title[1]),
        company: null,
        date: when,
        url: link[0],
        imageUrl: img ? toHttps(img[1]) : null,
      });
    }
    return items;
  }

  // ── Building an article ───────────────────────────────────────────────────

  private async toArticle(item: ListingItem, stocks: StockRef[]) {
    const stock = item.company ? matchStock(item.company, stocks) : null;
    const company = stock?.name ?? (item.company ? titleCase(item.company) : 'Malawi Stock Exchange');
    const title = tidyTitle(item.title, stocks);

    let body: string[];
    let imageUrl: string | null = item.imageUrl;

    if (item.kind === 'market') {
      // The detail page's own picture is the write-up; the list's is a stock photo.
      imageUrl = (await this.detailImage(item.url)) ?? imageUrl;
      body = [
        `${title}, from the Malawi Stock Exchange.`,
        'The full write-up is published on the MSE website.',
      ];
    } else if (item.kind === 'accounts') {
      body = resultsSummary(company, item.title);
    } else {
      const text = await this.pdfText(item.url).catch(() => '');
      body = readable(text) ? paragraphs(text, title) : noticeSummary(company, item.title);
    }

    return {
      origin: 'mse',
      sourceUrl: item.url,
      title,
      summary: body[0]?.slice(0, 200) ?? null,
      body,
      source: company,
      category: categoryFor(stock, item),
      imageUrl,
      featured: false,
      isPublished: true,
      publishedAt: item.date,
    };
  }

  private async detailImage(url: string): Promise<string | null> {
    try {
      const html = await this.fetchText(url);
      const main = html.split('</header>')[1] ?? html;
      const m = main.match(/<img[^>]+src="([^"]*\/images\/catalog\/[^"]+)"/i);
      return m ? toHttps(m[1]) : null;
    } catch {
      return null;
    }
  }

  /**
   * The text of the first two pages, laid out as paragraphs separated by a
   * blank line, or '' if the PDF has none to give.
   *
   * Joining pdfjs's text items with spaces is not enough: some notices place
   * every glyph separately, which came out as "N o t i c e i s h e r e b y".
   * So the text is rebuilt from where each piece sits on the page — see
   * layoutText().
   */
  private async pdfText(url: string): Promise<string> {
    const buffer = await this.fetchBuffer(url);
    if (buffer.length > MAX_PDF_BYTES || buffer.subarray(0, 5).toString() !== '%PDF-') return '';
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
    }).promise;
    const pages: string[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      const glyphs: Glyph[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !('transform' in item)) continue;
        const t = item.transform as number[];
        glyphs.push({
          str: item.str,
          x: t[4],
          y: t[5],
          w: item.width,
          size: Math.hypot(t[0], t[1]) || item.height || 10,
        });
      }
      pages.push(layoutText(glyphs));
    }
    return pages.filter(Boolean).join('\n\n');
  }

  private async stockIndex(): Promise<StockRef[]> {
    const rows = await this.prisma.stock.findMany({ select: { symbol: true, name: true, sector: true } });
    return rows.map((r) => ({ ...r, key: companyKey(r.name) }));
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async fetchText(url: string): Promise<string> {
    return (await this.fetchRaw(url)).text();
  }

  private async fetchBuffer(url: string): Promise<Buffer> {
    return Buffer.from(await (await this.fetchRaw(url)).arrayBuffer());
  }

  private async fetchRaw(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`${res.status} from ${url}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Pure helpers (exported for the spec) ────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "29-Sep-2026" or "08 September 2026" → a Date at noon UTC (no day drift). */
export function parseDate(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]), 12));
}

function clean(htmlFragment: string): string {
  return decodeEntities(htmlFragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function toHttps(url: string): string {
  return encodeURI(decodeURI(url.replace(/^http:\/\//i, 'https://')));
}

const DROP_WORDS = /\b(plc|limited|ltd|holdings?|company|co|the|of|malawi)\b/g;

/** "NATIONAL BANK OF MALAWI" and "National Bank of Malawi plc" agree. */
export function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(DROP_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

export function matchStock(company: string, stocks: StockRef[]): StockRef | null {
  const key = companyKey(company);
  if (!key) return null;
  return (
    stocks.find((s) => s.key === key) ??
    stocks.find((s) => s.key && (s.key.includes(key) || key.includes(s.key))) ??
    null
  );
}

/** The app's news tabs are Banking, Insurance and Markets. */
function categoryFor(stock: StockRef | null, item: ListingItem): string {
  const sector = (stock?.sector ?? '').toLowerCase();
  if (sector.includes('bank') || /\bbank\b/i.test(item.company ?? '')) return 'Banking';
  if (sector.includes('insur') || /insurance/i.test(item.company ?? '')) return 'Insurance';
  return 'Markets';
}

const SMALL = new Set(['of', 'and', 'the', 'for', 'to', 'in', 'on', 'at', 'a', 'an', 'by']);

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\bPlc\b/g, 'plc');
}

/**
 * Shouting titles ("NITL PLC APPOINTMENT OF BOARD CHAIRPERSON") are recased;
 * tickers and short codes keep their capitals. Already-cased titles are left
 * alone, since the MSE's own casing is usually right.
 */
export function tidyTitle(raw: string, stocks: StockRef[]): string {
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const upper = raw.replace(/[^A-Z]/g, '');
  if (!letters || upper.length / letters.length < 0.8) return raw.replace(/\s*-\s*/g, ' – ').trim();
  const tickers = new Set(stocks.map((s) => s.symbol.toUpperCase()));
  const keep = (w: string) => tickers.has(w) || /^(AGM|EGM|CEO|CFO|MSE|HY\d{4}|FY\d{4}|Y\d{4}|Q[1-4])$/.test(w);
  // Split on the dash first: "CHAIRPERSON-JOLLY" is two words that each need
  // a capital, not one word that gets only the first.
  return raw
    .replace(/\s*-\s*/g, ' – ')
    .split(/\s+/)
    .map((w, i) => {
      const bare = w.replace(/[’']S$/i, '').replace(/[^A-Za-z0-9]/g, '');
      if (keep(bare)) return w.replace(/([’'])S$/, '$1s');
      const lower = w.toLowerCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ')
    .replace(/\bPlc\b/g, 'plc')
    .replace(/\s*-\s*/g, ' – ');
}

/** Prose rather than a table of figures, and enough of it to be worth reading. */
export function readable(text: string): boolean {
  if (text.length < 160) return false;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const digits = (text.match(/[0-9]/g) ?? []).length;
  if (letters / Math.max(1, letters + digits) <= 0.75) return false;
  // "N o t i c e" survived the layout repair: not something to publish.
  const words = text.split(/\s+/).filter(Boolean);
  const single = words.filter((w) => w.length === 1).length;
  if (single / Math.max(1, words.length) >= 0.3) return false;
  // ...nor is "ContinentalHoldingsPlcNotice", the opposite failure.
  const avg = words.reduce((n, w) => n + w.length, 0) / Math.max(1, words.length);
  return avg < 11;
}

export interface Glyph {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

/**
 * Rebuilds readable text from positioned pieces of text.
 *
 * Pieces on the same baseline form a line; a space goes in only where there
 * is a real horizontal gap, which is what repairs letter-by-letter PDFs.
 * A line spacing noticeably larger than usual starts a new paragraph, and a
 * word split across lines with a hyphen is joined back up.
 */
export function layoutText(glyphs: Glyph[]): string {
  const pieces = glyphs.filter((g) => g.str !== '');
  if (!pieces.length) return '';

  // PDF y grows upwards: top of the page first, then left to right.
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Array<{ y: number; size: number; parts: Glyph[] }> = [];
  for (const g of pieces) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - g.y) < Math.max(line.size, g.size) * 0.5) {
      line.parts.push(g);
      line.size = Math.max(line.size, g.size);
    } else {
      lines.push({ y: g.y, size: g.size, parts: [g] });
    }
  }

  // Some PDFs report every glyph as being as wide as the font is tall, so
  // neighbours appear to overlap and no gap can be measured. Spacing cannot be
  // recovered from those; say so rather than return words run together.
  let measured = 0;
  let overlapping = 0;
  for (const line of lines) {
    const ps = [...line.parts].sort((a, b) => a.x - b.x);
    for (let i = 1; i < ps.length; i++) {
      measured += 1;
      if (ps[i].x - (ps[i - 1].x + ps[i - 1].w) < -0.3 * ps[i].size) overlapping += 1;
    }
  }
  if (measured > 20 && overlapping / measured > 0.4) return '';

  const text = lines.map((line) => {
    line.parts.sort((a, b) => a.x - b.x);
    let out = '';
    let prev: Glyph | null = null;
    for (const g of line.parts) {
      if (prev) {
        const gap = g.x - (prev.x + prev.w);
        const needsSpace = gap > Math.min(prev.size, g.size) * 0.18;
        if (needsSpace && !out.endsWith(' ') && !g.str.startsWith(' ')) out += ' ';
      }
      out += g.str;
      prev = g;
    }
    return out.replace(/\s+/g, ' ').trim();
  });

  // The usual gap between lines; anything clearly larger is a paragraph break.
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const usual = sorted[Math.floor(sorted.length / 2)] ?? 0;

  let result = '';
  text.forEach((line, i) => {
    if (!line) return;
    if (!result) {
      result = line;
      return;
    }
    const gap = lines[i - 1].y - lines[i].y;
    if (usual > 0 && gap > usual * 1.45) {
      result += '\n\n' + line;
    } else if (/[A-Za-z]-$/.test(result) && /^[a-z]/.test(line)) {
      result = result.slice(0, -1) + line;
    } else {
      result += ' ' + line;
    }
  });
  return result.trim();
}

const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|Prof|Hon|Rev|Messrs|No|Nos|Ltd|Co|Inc|St|vs|etc|e\.g|i\.e)\./g;
const DOT = '\u2024';

/** Sentences, without breaking after "Mr." or "Ltd.". */
export function sentences(text: string): string[] {
  const guarded = text.replace(ABBREVIATIONS, (m) => m.slice(0, -1) + DOT);
  const parts = guarded.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [guarded];
  return parts.map((p) => p.replace(new RegExp(DOT, 'g'), '.').trim()).filter(Boolean);
}

function isHeading(para: string): boolean {
  const letters = para.replace(/[^A-Za-z]/g, '');
  if (!letters) return true;
  const upper = para.replace(/[^A-Z]/g, '').length / letters.length;
  // A shouted line, or a short label with no full stop: a title, a name, a date.
  // "(Incorporated in the Republic of Mauritius) (Registration No. …)" is
  // letterhead, not news.
  const parenthetical = /^\(.*\)$/.test(para);
  return upper > 0.7 || parenthetical || (para.length < 70 && !/[.!?:]$/.test(para));
}

/**
 * The notice's own paragraphs, cleaned for a phone screen: the heading block
 * it opens with is dropped (the app shows the title already), long blocks are
 * split three sentences at a time, and it stops at five paragraphs with a
 * pointer to the original.
 */
export function paragraphs(text: string, _title: string): string[] {
  let blocks = text.split(/\n{2,}/).map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
  while (blocks.length > 1 && isHeading(blocks[0])) blocks.shift();

  // A notice laid out as one block still opens with its heading run into the
  // first sentence; drop leading shouted words up to the first normal one.
  if (blocks.length) {
    blocks[0] = blocks[0].replace(/^(?:[A-Z0-9][A-Z0-9&,'’()\-–.]*\s+){3,}(?=[A-Z][a-z])/, '').trim();
  }

  const out: string[] = [];
  let total = 0;
  let truncated = false;
  for (const block of blocks) {
    const chunks =
      block.length > 650
        ? (() => {
            const ss = sentences(block);
            const cs: string[] = [];
            for (let i = 0; i < ss.length; i += 3) cs.push(ss.slice(i, i + 3).join(' '));
            return cs;
          })()
        : [block];
    for (const chunk of chunks) {
      if (out.length >= 5 || total + chunk.length > 1600) {
        truncated = true;
        break;
      }
      out.push(chunk);
      total += chunk.length;
    }
    if (truncated) break;
  }
  if (truncated) out.push('The full notice continues in the original document.');
  return out;
}

const PERIOD: Array<[RegExp, (y: string) => string]> = [
  [/\bHY ?(\d{4})\b/i, (y) => `half-year ${y}`],
  [/\bFY ?(\d{4})\b/i, (y) => `full-year ${y}`],
  [/\bQ([1-4]) ?(\d{4})\b/i, (y) => `quarter ${y}`],
];

export function resultsSummary(company: string, title: string): string[] {
  let period = 'latest';
  for (const [re, fmt] of PERIOD) {
    const m = title.match(re);
    if (m) {
      period = m.length > 2 ? `Q${m[1]} ${m[2]}` : fmt(m[1]);
      break;
    }
  }
  const audited = /unaudited/i.test(title) ? 'unaudited ' : /audited/i.test(title) ? 'audited ' : '';
  return [
    `${company} has published its ${audited}${period} financial results.`,
    'Results show how a company has done over the period: its revenue, its profit or loss, and what it owns and owes. ' +
      'Shareholders often compare them with the same period a year earlier.',
    'The full statements are in the original document.',
  ];
}

export function noticeSummary(company: string, title: string): string[] {
  const t = title.toLowerCase();
  if (t.includes('dividend')) {
    return [
      `${company} has announced a dividend.`,
      'A dividend is part of the company\'s profit paid out to shareholders. The notice gives the amount per share, ' +
        'the date by which you must hold the shares to qualify, and when it will be paid.',
      'The details are in the original notice.',
    ];
  }
  if (t.includes('cautionary')) {
    return [
      `${company} has issued a cautionary announcement.`,
      'A cautionary tells shareholders that something which could move the share price is under way, ' +
        'and advises care when buying or selling until it is resolved.',
      'The details are in the original notice.',
    ];
  }
  if (/\b(agm|egm|annual general|general meeting)\b/.test(t)) {
    return [
      `${company} has given notice of a shareholders' meeting.`,
      'Shareholders can attend, ask questions and vote on the business set out in the notice.',
      'The details are in the original notice.',
    ];
  }
  if (/appoint|resign|retire/.test(t)) {
    return [
      `${company} has announced a change to its leadership.`,
      'The details are in the original notice.',
    ];
  }
  return [`${company} has published a notice to the market: "${title}".`, 'The details are in the original notice.'];
}
