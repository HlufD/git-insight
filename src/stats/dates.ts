const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` part of a strict ISO date, i.e. the day in the author's own timezone. */
export function localDay(isoDate: string): string {
  return isoDate.slice(0, 10);
}

/** Monday (`YYYY-MM-DD`) of the ISO week containing `day`. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const time = Date.UTC(y!, m! - 1, d!);
  const dow = new Date(time).getUTCDay(); // 0 = Sunday
  return new Date(time - ((dow + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** Every Monday from `first` to `last` (both week starts), inclusive. */
export function weekRange(first: string, last: string): string[] {
  const weeks: string[] = [];
  let time = Date.parse(`${first}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  while (time <= end) {
    weeks.push(new Date(time).toISOString().slice(0, 10));
    time += 7 * DAY_MS;
  }
  return weeks;
}

export function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}
