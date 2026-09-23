import { FIELD_SEP, RECORD_SEP } from '../formats';
import { unquoteCPath } from './cQuote';

export interface FileChange {
  /** Repo-relative path with forward slashes; for renames, the new path. */
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface CommitRecord {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Strict ISO 8601 with the author's UTC offset, e.g. `2026-08-03T10:45:00+03:00`. */
  authorDate: string;
  files: FileChange[];
}

const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Incremental parser for `git log --numstat` with {@link STATS_LOG_FORMAT}.
 * Feed it one line at a time; it returns each commit once the next one starts.
 */
export class LogNumstatParser {
  private current: CommitRecord | undefined;
  /** Header lines that could not be parsed (should stay 0). */
  malformed = 0;

  push(line: string): CommitRecord | undefined {
    if (line.startsWith(RECORD_SEP)) {
      const done = this.current;
      this.current = parseHeader(line.slice(1));
      if (!this.current) this.malformed++;
      return done;
    }
    if (!this.current || line === '') return undefined;
    const change = parseNumstatLine(line);
    if (change) this.current.files.push(change);
    return undefined;
  }

  /** Returns the last commit; call once after the input ends. */
  end(): CommitRecord | undefined {
    const done = this.current;
    this.current = undefined;
    return done;
  }
}

/** Parses a whole `git log` output at once. Convenient for tests and small outputs. */
export function parseLogNumstat(text: string): CommitRecord[] {
  const parser = new LogNumstatParser();
  const commits: CommitRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const commit = parser.push(line);
    if (commit) commits.push(commit);
  }
  const last = parser.end();
  if (last) commits.push(last);
  return commits;
}

function parseHeader(header: string): CommitRecord | undefined {
  const fields = header.split(FIELD_SEP);
  const [sha, parents, authorName, authorEmail, authorDate] = fields;
  if (fields.length < 5 || !sha || !SHA.test(sha) || !authorDate) return undefined;
  return {
    sha,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    authorDate,
    files: [],
  };
}

export function parseNumstatLine(line: string): FileChange | undefined {
  const match = NUMSTAT_LINE.exec(line);
  if (!match) return undefined;
  const [, added, removed, rawPath] = match;
  const binary = added === '-' || removed === '-';
  return {
    path: resolveRenamedPath(unquoteCPath(rawPath!)),
    added: binary ? 0 : Number(added),
    removed: binary ? 0 : Number(removed),
    binary,
  };
}

/**
 * Numstat shows renames as `src/{old => new}/a.ts` or `old.ts => new.ts`.
 * Returns the path after the rename.
 */
export function resolveRenamedPath(path: string): string {
  const braced = /\{([^{}]*) => ([^{}]*)\}/;
  if (braced.test(path)) {
    return path.replace(braced, '$2').replace(/\/{2,}/g, '/').replace(/^\//, '');
  }
  const arrow = path.indexOf(' => ');
  return arrow === -1 ? path : path.slice(arrow + 4);
}
