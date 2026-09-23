import { GitCommandError, GitInsightError } from '../git/errors';
import type { GitRunner } from '../git/GitRunner';
import { DIFF_PREFIX_ARGS, HISTORY_LOG_FORMAT } from '../git/formats';
import { parseLineLog, parseNameStatusLog, type FileRef, type HistoryEntry } from '../git/parsers/historyLog';

export interface HistoryTarget {
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Function/method/class name for `git log -L :<name>:<file>`, if known. */
  name?: string;
  /** Text for the all-branches search (`git log -S`); defaults to `name`. */
  searchTerm?: string;
  /** 1-based inclusive line range in the committed (HEAD) version of the file. */
  range?: { start: number; end: number };
  /**
   * The working file differs from HEAD, so editor line numbers may not match
   * the committed file. Try the function name before the line range.
   */
  preferName?: boolean;
}

export type HistoryMode = 'function' | 'range' | 'file';

export interface TimelineEntry extends HistoryEntry {
  /** First line of the tracked code in this commit's version (line history only). */
  line?: number;
  /** The oldest commit of a complete timeline: where the code (or name, or file) first appeared. */
  firstAdded: boolean;
}

export interface Timeline {
  entries: TimelineEntry[];
  /** More commits exist than were loaded. */
  truncated: boolean;
}

export interface CodeHistory {
  mode: HistoryMode;
  path: string;
  name?: string;
  range?: { start: number; end: number };
  history: Timeline;
  /** Why a more precise mode was not used (e.g. git could not find the function). */
  fallbackReasons: string[];
  /** Commits on any branch that added or removed the name (`git log -S`). */
  pickaxe?: Timeline & { term: string };
}

export interface HistoryRequest {
  runner: Pick<GitRunner, 'run'>;
  target: HistoryTarget;
  maxCommits: number;
  /** Also search all branches for commits that add or remove `target.name`. */
  pickaxe: boolean;
  signal?: AbortSignal;
}

/** Thrown when the file has never been committed, so it has no history. */
export class NotCommittedError extends GitInsightError {
  constructor(readonly path: string) {
    super(`${path} has not been committed yet, so it has no history.`);
  }
}

/**
 * Escapes a name for git's `-L :<funcname>:` form, which is a POSIX basic
 * regular expression: only `. * [ ] ^ $ \` are special there.
 */
export function escapeFuncname(name: string): string {
  return name.replace(/[.*[\]^$\\]/g, '\\$&');
}

/** Names worth searching for: identifiers like `getUser`, `$scope`, `Foo::bar`. */
export function isSearchableName(name: string | undefined): name is string {
  return !!name && name.length >= 2 && name.length <= 200 && !/[\r\n]/.test(name) && /[\p{L}\p{N}_$]/u.test(name);
}

/**
 * Loads the history of a function or line range. Tries the most precise mode
 * first and falls back: function name ↔ line range, then whole file (`--follow`).
 */
export async function loadCodeHistory(request: HistoryRequest): Promise<CodeHistory> {
  const { runner, target, maxCommits, signal } = request;
  await assertCommitted(runner, target.path, signal);

  const attempts: HistoryMode[] = target.preferName || !target.range ? ['function', 'range'] : ['range', 'function'];
  const fallbackReasons: string[] = [];
  let result: { mode: HistoryMode; history: Timeline } | undefined;

  for (const mode of attempts) {
    let spec: string;
    if (mode === 'function') {
      if (!isSearchableName(target.name)) continue;
      spec = `:${escapeFuncname(target.name)}:${target.path}`;
    } else {
      if (!target.range) continue;
      spec = `${target.range.start},${target.range.end}:${target.path}`;
    }
    try {
      const output = await runner.run(['log', `-L${spec}`, '--no-ext-diff', ...DIFF_PREFIX_ARGS, `--max-count=${maxCommits + 1}`, HISTORY_LOG_FORMAT], { signal });
      result = { mode, history: toTimeline(parseLineLog(output), maxCommits, true) };
      break;
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
      fallbackReasons.push(describeLineLogFailure(mode, target, error));
    }
  }

  if (!result) {
    const output = await runner.run(['log', '--follow', '--name-status', '--no-ext-diff', `--max-count=${maxCommits + 1}`, HISTORY_LOG_FORMAT, '--', target.path], { signal });
    result = { mode: 'file', history: toTimeline(parseNameStatusLog(output), maxCommits, false) };
  }

  const history: CodeHistory = {
    mode: result.mode,
    path: target.path,
    name: target.name,
    range: target.range,
    history: result.history,
    fallbackReasons,
  };

  const term = target.searchTerm ?? target.name;
  if (request.pickaxe && isSearchableName(term)) {
    const output = await runner.run(['log', '--all', `-S${term}`, '--name-status', '--no-ext-diff', `--max-count=${maxCommits + 1}`, HISTORY_LOG_FORMAT], { signal });
    history.pickaxe = { term, ...toTimeline(parseNameStatusLog(output), maxCommits, false) };
  }
  return history;
}

/** True when the committed file differs from the working tree (so line numbers may be off). */
export async function isModifiedSinceHead(runner: Pick<GitRunner, 'run'>, path: string, signal?: AbortSignal): Promise<boolean> {
  const output = await runner.run(['diff', '--numstat', '--no-ext-diff', 'HEAD', '--', path], { signal });
  return output.trim().length > 0;
}

async function assertCommitted(runner: Pick<GitRunner, 'run'>, path: string, signal?: AbortSignal): Promise<void> {
  try {
    await runner.run(['cat-file', '-e', `HEAD:${path}`], { signal });
  } catch (error) {
    if (error instanceof GitCommandError) throw new NotCommittedError(path);
    throw error;
  }
}

function toTimeline(entries: HistoryEntry[], maxCommits: number, lineHistory: boolean): Timeline {
  const truncated = entries.length > maxCommits;
  const kept = entries.slice(0, maxCommits).map(
    (e): TimelineEntry => ({ ...e, line: lineHistory ? e.hunks[0]?.newStart : undefined, firstAdded: false }),
  );
  const oldest = kept.at(-1);
  if (oldest && !truncated) oldest.firstAdded = true;
  return { entries: kept, truncated };
}

function describeLineLogFailure(mode: HistoryMode, target: HistoryTarget, error: GitCommandError): string {
  const detail = error.stderr.trim().split(/\r?\n/)[0]?.replace(/^fatal:\s*/, '') ?? '';
  return mode === 'function'
    ? `Git could not find a function named "${target.name}" in ${target.path} (${detail}).`
    : `Git could not follow lines ${target.range!.start}–${target.range!.end} (${detail}).`;
}

/** The file to diff for an entry: the only file, or the one matching `path`. */
export function primaryFile(entry: HistoryEntry, path: string): FileRef | undefined {
  return entry.files.find((f) => f.path === path || f.oldPath === path) ?? (entry.files.length === 1 ? entry.files[0] : undefined);
}
