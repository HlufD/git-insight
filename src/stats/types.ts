export interface StatsFilter {
  /** Inclusive start day `YYYY-MM-DD`, compared with the author's local date. */
  since?: string;
  /** Inclusive end day `YYYY-MM-DD`. */
  until?: string;
  /** Full ref name (`refs/heads/main`); undefined means all refs (`--all`). */
  ref?: string;
  /** Path globs; only commits touching them are scanned. */
  paths?: string[];
}

/** Stats for one identity (name + email after `.mailmap`). */
export interface IdentityStats {
  /** `Name <email>` with the email lowercased. */
  id: string;
  name: string;
  email: string;
  /** Non-merge commits. */
  commits: number;
  merges: number;
  added: number;
  removed: number;
  /** Binary file changes; they have no line counts. */
  binaryFiles: number;
  firstTimestamp: number;
  firstDate: string;
  lastTimestamp: number;
  lastDate: string;
  /** Distinct days (`YYYY-MM-DD`) in the author's own timezone, sorted. */
  days: string[];
  /** Commits (merges included) per week, keyed by the week's Monday `YYYY-MM-DD`. */
  weekly: Record<string, number>;
}

/** Result of one git scan. Cacheable: it does not depend on aliases or bot settings. */
export interface RawStats {
  schema: number;
  fingerprint: string;
  filter: StatsFilter;
  createdAt: string;
  /** Commits that passed the date filter. */
  commitCount: number;
  identities: IdentityStats[];
}

export const RAW_STATS_SCHEMA = 1;
