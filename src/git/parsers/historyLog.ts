import { FIELD_SEP, RECORD_SEP } from '../formats';
import { unquoteCPath } from './cQuote';
import { resolveRenamedPath } from './logNumstat';

export interface HistoryCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Strict ISO 8601 in the author's timezone. */
  authorDate: string;
  subject: string;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export interface FileRef {
  /** Path in the commit (the new path for renames; the old path for deletions). */
  path: string;
  /** Path in the parent, when it differs (renames, copies). */
  oldPath?: string;
  status: ChangeStatus;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface HistoryEntry extends HistoryCommit {
  files: FileRef[];
  /** Only for line history: the hunks of the tracked range. */
  hunks: Hunk[];
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const HUNK = /^@@@* -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NAME_STATUS = /^([ACDMRTUXB])(\d*)\t(.+)$/;

const STATUS_LETTERS: Record<string, ChangeStatus> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed',
};

export function parseHistoryHeader(header: string): HistoryCommit | undefined {
  const fields = header.split(FIELD_SEP);
  const [sha, parents, authorName, authorEmail, authorDate, ...subject] = fields;
  if (fields.length < 6 || !sha || !SHA.test(sha) || !authorDate) return undefined;
  return {
    sha,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    authorDate,
    subject: subject.join(FIELD_SEP),
  };
}

/** Splits `git log` output with {@link HISTORY_LOG_FORMAT} into header + body lines per commit. */
function splitCommits(text: string): { commit: HistoryCommit; body: string[] }[] {
  const out: { commit: HistoryCommit; body: string[] }[] = [];
  let current: { commit: HistoryCommit; body: string[] } | undefined;
  for (const line of text.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (clean.startsWith(RECORD_SEP)) {
      const commit = parseHistoryHeader(clean.slice(1));
      current = commit ? { commit, body: [] } : undefined;
      if (current) out.push(current);
    } else if (current) {
      current.body.push(clean);
    }
  }
  return out;
}

/**
 * Parses `git log -L … --format=<HISTORY_LOG_FORMAT>` output. Diff headers are
 * only read between `diff --git` and the first `@@`, so changed lines that look
 * like `--- a/x` are never mistaken for headers.
 */
export function parseLineLog(text: string): HistoryEntry[] {
  return splitCommits(text).map(({ commit, body }) => {
    const entry: HistoryEntry = { ...commit, files: [], hunks: [] };
    let inHeader = false;
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let added = false;
    let deleted = false;
    const flush = () => {
      if (newPath === undefined && oldPath === undefined) return;
      const path = newPath ?? oldPath!;
      const status: ChangeStatus = added ? 'added' : deleted ? 'deleted' : oldPath !== undefined && oldPath !== path ? 'renamed' : 'modified';
      entry.files.push(status === 'renamed' ? { path, oldPath, status } : { path, status });
      oldPath = newPath = undefined;
      added = deleted = false;
    };

    for (const line of body) {
      if (line.startsWith('diff --git ')) {
        flush();
        inHeader = true;
      } else if (inHeader && line.startsWith('--- ')) {
        const p = diffPath(line.slice(4), 'a/');
        if (p === undefined) added = true;
        else oldPath = p;
      } else if (inHeader && line.startsWith('+++ ')) {
        const p = diffPath(line.slice(4), 'b/');
        if (p === undefined) deleted = true;
        else newPath = p;
      } else if (line.startsWith('@@')) {
        inHeader = false;
        const m = HUNK.exec(line);
        if (m) {
          entry.hunks.push({
            oldStart: Number(m[1]),
            oldCount: m[2] === undefined ? 1 : Number(m[2]),
            newStart: Number(m[3]),
            newCount: m[4] === undefined ? 1 : Number(m[4]),
          });
        }
      }
    }
    flush();
    return entry;
  });
}

/** Parses `git log --name-status --format=<HISTORY_LOG_FORMAT>` output. */
export function parseNameStatusLog(text: string): HistoryEntry[] {
  return splitCommits(text).map(({ commit, body }) => {
    const files: FileRef[] = [];
    for (const line of body) {
      const m = NAME_STATUS.exec(line);
      if (!m) continue;
      const status = STATUS_LETTERS[m[1]!] ?? 'modified';
      const paths = m[3]!.split('\t').map(unquoteCPath);
      if ((status === 'renamed' || status === 'copied') && paths.length >= 2) {
        files.push({ path: paths[1]!, oldPath: paths[0]!, status });
      } else {
        files.push({ path: resolveRenamedPath(paths[0]!), status });
      }
    }
    return { ...commit, files, hunks: [] };
  });
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` → undefined. Handles C-quoted names. */
function diffPath(raw: string, prefix: string): string | undefined {
  const path = unquoteCPath(raw.replace(/\t$/, ''));
  if (path === '/dev/null') return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
