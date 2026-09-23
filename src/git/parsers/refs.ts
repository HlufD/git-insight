import { FIELD_SEP } from '../formats';

export type RefKind = 'branch' | 'remote' | 'tag';

export interface RefInfo {
  /** Full name, e.g. `refs/heads/main`. Safe to pass to git (never starts with `-`). */
  name: string;
  /** Short name for display, e.g. `main`, `origin/main`, `v1.0`. */
  shortName: string;
  kind: RefKind;
}

/** `git for-each-ref` format matching {@link parseRefs}. */
export const REFS_FORMAT = '--format=%(refname)%1f%(refname:short)';
export const REFS_PATTERNS = ['refs/heads', 'refs/remotes', 'refs/tags'];

/** Parses `git for-each-ref` output; symbolic remote HEADs (`origin/HEAD`) are skipped. */
export function parseRefs(output: string): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [name, shortName] = line.split(FIELD_SEP);
    if (!name || !shortName) continue;
    const kind: RefKind | undefined = name.startsWith('refs/heads/')
      ? 'branch'
      : name.startsWith('refs/remotes/')
        ? 'remote'
        : name.startsWith('refs/tags/')
          ? 'tag'
          : undefined;
    if (!kind || (kind === 'remote' && name.endsWith('/HEAD'))) continue;
    refs.push({ name, shortName, kind });
  }
  return refs;
}
