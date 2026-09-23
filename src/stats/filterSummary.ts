import type { StatsFilter } from './types';

export function isFilterActive(filter: StatsFilter): boolean {
  return !!(filter.since || filter.until || filter.ref || filter.paths?.length);
}

/** One-line description, e.g. `main · 2026-01-01 → now · src/**`. */
export function describeFilter(filter: StatsFilter, refLabel?: string): string {
  const parts = [filter.ref ? (refLabel ?? filter.ref.replace(/^refs\/(heads|remotes|tags)\//, '')) : 'All branches'];
  parts.push(filter.since || filter.until ? `${filter.since ?? 'start'} → ${filter.until ?? 'now'}` : 'all time');
  parts.push(filter.paths?.length ? filter.paths.join(', ') : 'all paths');
  return parts.join(' · ');
}
