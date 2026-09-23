import { createHash } from 'node:crypto';
import { EmptyRepositoryError, GitInsightError } from '../git/errors';
import type { GitRunner } from '../git/GitRunner';
import { STATS_LOG_FORMAT } from '../git/formats';
import { LogNumstatParser } from '../git/parsers/logNumstat';
import { refsFingerprint, type RepoLocation } from '../git/repository';
import { StatsAccumulator } from './accumulator';
import { createPathMatcher, toGlobPathspecs } from './pathFilter';
import { RAW_STATS_SCHEMA, type RawStats, type StatsFilter } from './types';

export interface RawStatsCache {
  get(repoRoot: string, key: string): Promise<RawStats | undefined>;
  set(repoRoot: string, key: string, stats: RawStats): Promise<void>;
}

export interface ScanRequest {
  repo: RepoLocation;
  runner: Pick<GitRunner, 'run' | 'streamLines'>;
  filter: StatsFilter;
  /** Globs whose line changes are not counted. */
  excludePaths: readonly string[];
  cache?: RawStatsCache;
  signal?: AbortSignal;
  /** Called with the number of commits parsed so far. */
  onProgress?: (commits: number) => void;
}

export interface ScanResult {
  stats: RawStats;
  fromCache: boolean;
}

const PROGRESS_EVERY = 500;

/** Cache key: every input that changes the scan output. */
export function statsCacheKey(fingerprint: string, filter: StatsFilter, excludePaths: readonly string[]): string {
  const normalized = {
    schema: RAW_STATS_SCHEMA,
    fingerprint,
    since: filter.since ?? null,
    until: filter.until ?? null,
    ref: filter.ref ?? null,
    paths: [...(filter.paths ?? [])].sort(),
    excludePaths: [...excludePaths].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** git log arguments for a stats scan. */
export function statsLogArgs(filter: StatsFilter): string[] {
  if (filter.ref !== undefined && !/^refs\/[^\s]+$/.test(filter.ref)) {
    throw new GitInsightError(`Invalid ref "${filter.ref}": expected a full ref name such as refs/heads/main.`);
  }
  return [
    'log',
    filter.ref ?? '--all',
    '--use-mailmap',
    '--numstat',
    '--no-ext-diff',
    '--no-textconv',
    STATS_LOG_FORMAT,
    '--',
    ...toGlobPathspecs(filter.paths ?? []),
  ];
}

/**
 * Returns contributor stats for a repository, from cache when refs, `.mailmap`,
 * filters and excluded paths are unchanged (no git process in that case),
 * otherwise by streaming `git log --numstat`.
 */
export async function loadRawStats(request: ScanRequest): Promise<ScanResult> {
  const { repo, runner, filter, excludePaths, cache, signal, onProgress } = request;
  const fingerprint = await refsFingerprint(repo);
  const key = statsCacheKey(fingerprint, filter, excludePaths);
  const cached = await cache?.get(repo.root, key);
  if (cached) return { stats: cached, fromCache: true };

  const args = statsLogArgs(filter);
  const probe = await runner.run(['rev-list', '--max-count=1', filter.ref ?? '--all'], { signal });
  if (!probe.trim()) throw new EmptyRepositoryError(repo.root);

  const accumulator = new StatsAccumulator({
    since: filter.since,
    until: filter.until,
    isExcludedPath: createPathMatcher(excludePaths),
  });
  const parser = new LogNumstatParser();
  let parsed = 0;
  const take = (commit: ReturnType<LogNumstatParser['push']>) => {
    if (!commit) return;
    accumulator.add(commit);
    if (++parsed % PROGRESS_EVERY === 0) onProgress?.(parsed);
  };

  await runner.streamLines(args, (line) => take(parser.push(line)), { signal });
  take(parser.end());
  onProgress?.(parsed);

  const stats: RawStats = {
    schema: RAW_STATS_SCHEMA,
    fingerprint,
    filter,
    createdAt: new Date().toISOString(),
    commitCount: accumulator.commitCount,
    identities: accumulator.result(),
  };
  await cache?.set(repo.root, key, stats);
  return { stats, fromCache: false };
}
