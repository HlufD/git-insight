import * as vscode from 'vscode';
import { parseRefs, REFS_FORMAT, REFS_PATTERNS, type RefInfo } from '../git/parsers/refs';
import { describeFilter } from '../stats/filterSummary';
import { isIsoDay } from '../stats/dates';
import type { RepoService } from '../services/RepoService';
import type { StatsService } from '../services/StatsService';
import { showError } from '../services/errorUi';

/** CS-6: pick date range, branch and path filters. Each change rescans (or hits the cache). */
export async function setStatsFilters(stats: StatsService, repos: RepoService, log: vscode.LogOutputChannel): Promise<void> {
  const repo = stats.state.repo;
  if (!repo) return;
  const { filter, refLabel } = stats.state;

  const choice = await vscode.window.showQuickPick(
    [
      { id: 'dates', label: '$(calendar) Date range', description: filter.since || filter.until ? `${filter.since ?? 'start'} → ${filter.until ?? 'now'}` : 'all time' },
      { id: 'ref', label: '$(git-branch) Branch or tag', description: filter.ref ? (refLabel ?? filter.ref) : 'all branches' },
      { id: 'paths', label: '$(file-directory) Paths', description: filter.paths?.join(', ') ?? 'all paths' },
      { id: 'reset', label: '$(clear-all) Reset all filters' },
    ],
    { title: 'Git Insight: Stats Filters', placeHolder: describeFilter(filter, refLabel) },
  );
  if (!choice) return;

  switch (choice.id) {
    case 'dates': {
      const since = await askDay('Start date (inclusive)', filter.since);
      if (since === undefined) return;
      const until = await askDay('End date (inclusive)', filter.until, since || undefined);
      if (until === undefined) return;
      return stats.setFilter({ ...filter, since, until }, refLabel);
    }
    case 'ref': {
      let refs: RefInfo[];
      try {
        refs = parseRefs(await repos.runner(repo).run(['for-each-ref', REFS_FORMAT, ...REFS_PATTERNS]));
      } catch (error) {
        return showError(error, log, repo.root);
      }
      const icons = { branch: '$(git-branch)', remote: '$(cloud)', tag: '$(tag)' } as const;
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(list-tree) All branches', description: '--all', ref: undefined as RefInfo | undefined },
          ...refs.map((ref) => ({ label: `${icons[ref.kind]} ${ref.shortName}`, description: ref.kind, ref })),
        ],
        { title: 'Count commits reachable from', matchOnDescription: true },
      );
      if (!picked) return;
      return stats.setFilter({ ...filter, ref: picked.ref?.name }, picked.ref?.shortName);
    }
    case 'paths': {
      const value = await vscode.window.showInputBox({
        title: 'Only count commits touching these paths',
        prompt: 'Comma-separated globs relative to the repository root, e.g. src/**, docs/*.md. Leave empty for all paths.',
        value: filter.paths?.join(', ') ?? '',
      });
      if (value === undefined) return;
      const paths = value.split(',').map((p) => p.trim()).filter(Boolean);
      return stats.setFilter({ ...filter, paths }, refLabel);
    }
    case 'reset':
      return stats.setFilter({});
  }
}

/** Returns '' for "no limit", undefined when cancelled. */
async function askDay(title: string, current: string | undefined, notBefore?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: 'YYYY-MM-DD in the author’s timezone. Leave empty for no limit.',
    value: current ?? '',
    placeHolder: 'e.g. 2026-01-31',
    validateInput: (v) => {
      const value = v.trim();
      if (!value) return undefined;
      if (!isIsoDay(value)) return 'Use the form YYYY-MM-DD with a real date.';
      if (notBefore && value < notBefore) return `Must be on or after ${notBefore}.`;
      return undefined;
    },
  }).then((v) => v?.trim());
}
