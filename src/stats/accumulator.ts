import type { CommitRecord } from '../git/parsers/logNumstat';
import { localDay, weekStart } from './dates';
import { identityId } from './identity';
import type { IdentityStats } from './types';

export interface AccumulatorOptions {
  since?: string;
  until?: string;
  /** Paths whose line changes are ignored (lockfiles, build output…). */
  isExcludedPath?: (path: string) => boolean;
}

interface Working extends Omit<IdentityStats, 'days'> {
  daySet: Set<string>;
}

/** Folds commits into per-identity stats, one commit at a time. */
export class StatsAccumulator {
  private readonly byId = new Map<string, Working>();
  commitCount = 0;

  constructor(private readonly options: AccumulatorOptions = {}) {}

  add(commit: CommitRecord): void {
    const day = localDay(commit.authorDate);
    const { since, until, isExcludedPath } = this.options;
    if (since && day < since) return;
    if (until && day > until) return;

    const timestamp = Date.parse(commit.authorDate);
    if (Number.isNaN(timestamp)) return;
    this.commitCount++;

    const id = identityId(commit.authorName, commit.authorEmail);
    let s = this.byId.get(id);
    if (!s) {
      s = {
        id,
        name: commit.authorName,
        email: commit.authorEmail,
        commits: 0,
        merges: 0,
        added: 0,
        removed: 0,
        binaryFiles: 0,
        firstTimestamp: timestamp,
        firstDate: commit.authorDate,
        lastTimestamp: timestamp,
        lastDate: commit.authorDate,
        daySet: new Set(),
        weekly: {},
      };
      this.byId.set(id, s);
    }

    if (commit.parents.length > 1) s.merges++;
    else s.commits++;

    for (const file of commit.files) {
      if (isExcludedPath?.(file.path)) continue;
      if (file.binary) s.binaryFiles++;
      s.added += file.added;
      s.removed += file.removed;
    }

    if (timestamp < s.firstTimestamp) {
      s.firstTimestamp = timestamp;
      s.firstDate = commit.authorDate;
    }
    if (timestamp > s.lastTimestamp) {
      s.lastTimestamp = timestamp;
      s.lastDate = commit.authorDate;
    }
    s.daySet.add(day);
    const week = weekStart(day);
    s.weekly[week] = (s.weekly[week] ?? 0) + 1;
  }

  result(): IdentityStats[] {
    return [...this.byId.values()].map(({ daySet, ...rest }) => ({ ...rest, days: [...daySet].sort() }));
  }
}
