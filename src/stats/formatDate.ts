const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface ReadableDateOptions {
  weekday?: boolean;
  time?: boolean;
  shortMonth?: boolean;
}

/**
 * Formats a strict ISO date in the timezone it was written in (the author's),
 * e.g. `Mon, 3 August 2026, 10:45`. Returns the input unchanged if it is not ISO.
 */
export function formatReadableDate(iso: string, options: ReadableDateOptions = {}): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso);
  if (!match) return iso;
  const [, y, m, d, hh, mm] = match;
  const month = MONTHS[Number(m) - 1];
  if (!month) return iso;
  let text = `${Number(d)} ${options.shortMonth ? month.slice(0, 3) : month} ${y}`;
  if (options.weekday) text = `${WEEKDAYS[new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay()]}, ${text}`;
  if (options.time && hh !== undefined) text += `, ${hh}:${mm}`;
  return text;
}

/** Compact number: 950, 1.2k, 34k, 1.5M. */
export function formatCount(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(value);
  if (abs < 1_000_000) return `${trim(value / 1000)}k`;
  return `${trim(value / 1_000_000)}M`;
}

function trim(value: number): string {
  return (Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value).toString()).replace(/\.0$/, '');
}
