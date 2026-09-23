/** Separates commits in `git log` output. Git names cannot contain it. */
export const RECORD_SEP = '\x1e';
/** Separates fields inside one commit header. */
export const FIELD_SEP = '\x1f';

/**
 * Commit header for contributor stats: sha, parents, author name, author email,
 * author date (strict ISO 8601 in the author's own timezone). `%aN`/`%aE` apply `.mailmap`.
 */
export const STATS_LOG_FORMAT = `--format=%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f`;

/** Commit header for timelines: sha, parents, author name/email/date, subject. */
export const HISTORY_LOG_FORMAT = `--format=%x1e%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f%s`;

/** Fixed diff prefixes, whatever `diff.noprefix` / `diff.mnemonicPrefix` say. */
export const DIFF_PREFIX_ARGS = ['--src-prefix=a/', '--dst-prefix=b/'];
