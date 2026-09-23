import picomatch from 'picomatch';

/** Returns a predicate that is true for repo-relative paths matching any glob. */
export function createPathMatcher(globs: readonly string[]): (path: string) => boolean {
  const patterns = globs.map((g) => g.trim()).filter(Boolean);
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { dot: true });
}

/** Turns user globs into git pathspecs; `:(glob)` makes `**` behave as in the setting. */
export function toGlobPathspecs(globs: readonly string[]): string[] {
  return globs
    .map((g) => g.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .map((g) => `:(glob)${g}`);
}
