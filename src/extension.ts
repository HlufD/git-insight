import * as vscode from 'vscode';
import { reviewAliases } from './commands/aliases';
import { exportMailmap, exportStats } from './commands/exports';
import { setStatsFilters } from './commands/filters';
import { copyCommitSha, openCommitDiff } from './commands/history';
import { Commands, GIT_SCHEME, STATS_PANEL_TYPE, Views } from './constants';
import { GitContentProvider } from './providers/GitContentProvider';
import { HistoryService } from './services/HistoryService';
import { RepoService } from './services/RepoService';
import { StatsService } from './services/StatsService';
import { CodeHistoryTree } from './views/CodeHistoryTree';
import { ContributorsTree } from './views/ContributorsTree';
import { StatsPanel } from './webviews/StatsPanel';

/** Returned from `activate` so integration tests (and other extensions) can drive Git Insight. */
export interface GitInsightApi {
  repos: RepoService;
  stats: StatsService;
  history: HistoryService;
}

export async function activate(context: vscode.ExtensionContext): Promise<GitInsightApi> {
  const log = vscode.window.createOutputChannel('Git Insight', { log: true });
  const repos = new RepoService(context.workspaceState, log);
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  const stats = new StatsService(repos, context.workspaceState, storage, log);
  const tree = new ContributorsTree(Views.contributors, stats);
  const history = new HistoryService(repos, log);
  const historyTree = new CodeHistoryTree(Views.codeHistory, history);

  const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);

  context.subscriptions.push(
    log,
    repos,
    stats,
    tree,
    history,
    historyTree,
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider(repos, log)),
    command(Commands.whoWroteThis, () => history.whoWroteThis()),
    command(Commands.refreshCodeHistory, () => history.rerun()),
    command(Commands.openCommitDiff, openCommitDiff),
    command(Commands.copyCommitSha, copyCommitSha),
    command(Commands.selectRepository, () => repos.pick()),
    command(Commands.showContributorStats, (focusId?: string) => StatsPanel.show(context.extensionUri, stats, typeof focusId === 'string' ? focusId : undefined)),
    command(Commands.refreshContributors, () => stats.refresh()),
    command(Commands.setStatsFilters, () => setStatsFilters(stats, repos, log)),
    command(Commands.reviewAliases, () => reviewAliases(stats)),
    command(Commands.exportMailmap, () => exportMailmap(stats)),
    command(Commands.exportStatsCsv, () => exportStats(stats, 'csv')),
    command(Commands.exportStatsMarkdown, () => exportStats(stats, 'markdown')),
    command(Commands.clearCache, async () => {
      await stats.clearCache();
      void vscode.window.showInformationMessage('Git Insight cache cleared.');
    }),
    vscode.window.registerWebviewPanelSerializer(STATS_PANEL_TYPE, {
      deserializeWebviewPanel: async (panel) => StatsPanel.revive(panel, context.extensionUri, stats),
    }),
  );

  await repos.discover();
  return { repos, stats, history };
}

export function deactivate(): void {}
