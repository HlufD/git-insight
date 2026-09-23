import type { Contributor } from './report';
import type { StatsFilter } from './types';

export interface ExportMeta {
  repoName: string;
  generatedAt: Date;
  filter: StatsFilter;
  refLabel?: string;
}

const COLUMNS = [
  'Name', 'Emails', 'Commits', 'Merge commits', 'Lines added', 'Lines removed',
  'Binary files', 'First commit', 'Last commit', 'Active days',
] as const;

function row(c: Contributor): (string | number)[] {
  return [c.name, c.emails.join('; '), c.commits, c.merges, c.added, c.removed, c.binaryFiles, c.firstDate, c.lastDate, c.activeDays];
}

/**
 * CSV for Excel: UTF-8 BOM, CRLF, every field quoted. Text starting with
 * `= + - @` gets a leading apostrophe so spreadsheets don't run it as a formula.
 */
export function toCsv(contributors: readonly Contributor[]): string {
  const lines = [COLUMNS.map(csvField), ...contributors.map((c) => row(c).map(csvField))];
  return `\uFEFF${lines.map((l) => l.join(',')).join('\r\n')}\r\n`;
}

function csvField(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toMarkdown(contributors: readonly Contributor[], meta: ExportMeta): string {
  const out: string[] = [];
  out.push(`# Contributor stats — ${escapeMd(meta.repoName)}`, '');
  out.push(`- Generated: ${meta.generatedAt.toISOString()}`);
  out.push(`- Branch: ${escapeMd(meta.refLabel ?? 'all branches')}`);
  out.push(`- Date range: ${meta.filter.since ?? 'start'} → ${meta.filter.until ?? 'now'}`);
  if (meta.filter.paths?.length) out.push(`- Paths: ${meta.filter.paths.map((p) => `\`${p}\``).join(', ')}`);
  out.push('', `| ${COLUMNS.join(' | ')} |`, `| ${COLUMNS.map((_, i) => (i >= 2 && i <= 6) || i === 9 ? '---:' : '---').join(' | ')} |`);
  for (const c of contributors) {
    out.push(`| ${row(c).map((v) => (typeof v === 'number' ? String(v) : escapeMd(v))).join(' | ')} |`);
  }
  return `${out.join('\n')}\n`;
}

function escapeMd(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
