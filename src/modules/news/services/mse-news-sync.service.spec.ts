import { describe, expect, it } from 'vitest';
import {
  MseNewsSyncService,
  companyKey,
  matchStock,
  noticeSummary,
  paragraphs,
  parseDate,
  readable,
  resultsSummary,
  tidyTitle,
} from './mse-news-sync.service';

/* Fixtures are trimmed copies of the MSE's real markup (October 2026). If the
   site is redesigned these stop matching it, and the sync logs that it read
   nothing rather than publishing garbage. */
const CORPORATE_ROW = `
<tr><td></td><td><a href="https://mse.co.mw/company/MWNBM0010074"></a></td>
<td>NBM plc Y2026 Interim Dividend Payment Notice</td>
<td>NATIONAL BANK OF MALAWI</td><td>22-Sep-2026</td>
<td><a href="https://mse.co.mw/announcements/corporate/1362">Download</a></td></tr>`;

const MARKET_CARD = `
<div class="card news-card h-100 rounded-0">
  <img src="https://mse.co.mw/images/cache/investing-540x309.jpeg" alt="x" />
  <div class="card-body"><h5 class="title"><strong>CEO's roundtable Pictorial Focus</strong></h5>
  <p><small><span class="date">08 September 2026</span></small></p></div>
  <a href="https://mse.co.mw/announcements/market/72"></a>
</div>`;

const STOCKS = [
  { symbol: 'NBM', name: 'National Bank of Malawi plc', sector: 'Banking', key: companyKey('National Bank of Malawi plc') },
  { symbol: 'NITL', name: 'National Investment Trust plc', sector: 'Investment', key: companyKey('National Investment Trust plc') },
  { symbol: 'CHL', name: 'Continental Holdings plc', sector: 'Conglomerate', key: companyKey('Continental Holdings plc') },
];

const svc = new MseNewsSyncService({} as never, { mseNewsSync: true } as never) as unknown as {
  parseTableRows(kind: 'corporate' | 'accounts', html: string): Array<{ title: string; company: string | null; date: Date; url: string }>;
  parseMarketCards(html: string): Array<{ title: string; date: Date; url: string; imageUrl: string | null }>;
};

describe('reading the MSE listings', () => {
  it('reads a corporate announcement row', () => {
    const [item] = svc.parseTableRows('corporate', CORPORATE_ROW);
    expect(item.title).toBe('NBM plc Y2026 Interim Dividend Payment Notice');
    expect(item.company).toBe('NATIONAL BANK OF MALAWI');
    expect(item.url).toBe('https://mse.co.mw/announcements/corporate/1362');
    expect(item.date.toISOString().slice(0, 10)).toBe('2026-09-22');
  });

  it('ignores rows that are not announcements, such as the header', () => {
    expect(svc.parseTableRows('corporate', '<tr><th>Title</th><th>Company</th><th>Date</th></tr>')).toEqual([]);
  });

  it('reads an MSE News card', () => {
    const [item] = svc.parseMarketCards(MARKET_CARD);
    expect(item.title).toBe("CEO's roundtable Pictorial Focus");
    expect(item.url).toBe('https://mse.co.mw/announcements/market/72');
    expect(item.date.toISOString().slice(0, 10)).toBe('2026-09-08');
  });
});

describe('helpers', () => {
  it('reads both date styles the site uses', () => {
    expect(parseDate('29-Sep-2026')?.toISOString().slice(0, 10)).toBe('2026-09-29');
    expect(parseDate('08 September 2026')?.toISOString().slice(0, 10)).toBe('2026-09-08');
    expect(parseDate('Download')).toBeNull();
  });

  it('matches a shouted company name to its stock', () => {
    expect(matchStock('NATIONAL BANK OF MALAWI', STOCKS)?.symbol).toBe('NBM');
    expect(matchStock('Continental Holdings plc', STOCKS)?.symbol).toBe('CHL');
    expect(matchStock('Somebody Else Ltd', STOCKS)).toBeNull();
  });

  it('recases a shouted title but keeps tickers', () => {
    expect(tidyTitle('NITL PLC APPOINTMENT OF BOARD CHAIRPERSON-JOLLY NKHONJERA', STOCKS)).toBe(
      'NITL plc Appointment of Board Chairperson – Jolly Nkhonjera',
    );
    expect(tidyTitle('CHL plc Y2026 3rd Interim Dividend Payment Notice', STOCKS)).toBe(
      'CHL plc Y2026 3rd Interim Dividend Payment Notice',
    );
  });

  it('tells prose from a table of figures', () => {
    const prose =
      'The Board of Directors is pleased to announce the appointment of a new chairperson, effective 8 September 2026. ' +
      'She brings long experience in governance and finance to the role.';
    expect(readable(prose)).toBe(true);
    expect(readable('Revenue 12,345 23,456 34,567 Profit 1,234 2,345 3,456 '.repeat(5))).toBe(false);
    expect(readable('Too short.')).toBe(false);
  });

  it('turns notice text into short paragraphs and says when it stops early', () => {
    const text = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} of the notice.`).join(' ');
    const out = paragraphs(text, 'Some title');
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out[out.length - 1]).toBe('The full notice continues in the original document.');
  });

  it('summarises results by their period', () => {
    expect(resultsSummary('Press Corporation plc', 'PCL plc HY2026 Financials')[0]).toBe(
      'Press Corporation plc has published its half-year 2026 financial results.',
    );
    expect(resultsSummary('Airtel Malawi plc', 'Airtel FY2025 Audited Results')[0]).toBe(
      'Airtel Malawi plc has published its audited full-year 2025 financial results.',
    );
  });

  it('explains a dividend notice in plain words when the PDF has no text', () => {
    const [lead, explain] = noticeSummary('Continental Holdings plc', 'CHL plc Y2026 3rd Interim Dividend Payment Notice');
    expect(lead).toBe('Continental Holdings plc has announced a dividend.');
    expect(explain).toMatch(/paid out to shareholders/);
  });
});
