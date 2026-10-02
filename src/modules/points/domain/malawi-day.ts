/**
 * The calendar day an award counts against, in Malawi time.
 *
 * Every daily cap in the engine is measured in these days. It matters that
 * this is not the server's UTC day: Blantyre is UTC+2, so a user trading at
 * 1am local time would, under a naive UTC day, still be on "yesterday" and
 * could collect two days of caps within two hours. Isolated in its own file
 * because an off-by-one here breaks every cap silently, and this is the one
 * place to test for it.
 *
 * Returns a Date at UTC midnight for that Malawi day, which is exactly what
 * Postgres stores in a DATE column.
 */
export function toMalawiDay(at: Date, timeZone = 'Africa/Blantyre'): Date {
  // en-CA renders as YYYY-MM-DD, so the parts come out already ordered.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** The same day as a plain YYYY-MM-DD string, for building dedupe keys. */
export function toMalawiDayString(at: Date, timeZone = 'Africa/Blantyre'): string {
  return toMalawiDay(at, timeZone).toISOString().slice(0, 10);
}

/** Whole days from one Malawi day to another; negative when `b` is earlier. */
export function daysBetween(a: Date, b: Date): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}
