import * as path from 'node:path';
import * as vscode from 'vscode';
import { Commands, STATS_PANEL_TYPE } from '../constants';
import type { HostToWebview, StatsViewModel, WebviewToHost } from '../shared/messages';
import { describeFilter, isFilterActive } from '../stats/filterSummary';
import type { StatsService } from '../services/StatsService';
import { webviewHtml } from './html';

/** The contributor stats webview (CS-7): table, bar chart and weekly timeline. */
export class StatsPanel implements vscode.Disposable {
  private static current: StatsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private focusId: string | undefined;

  static show(extensionUri: vscode.Uri, stats: StatsService, focusId?: string): void {
    if (StatsPanel.current) {
      StatsPanel.current.focusId = focusId;
      StatsPanel.current.panel.reveal(undefined, false);
      StatsPanel.current.post();
      return;
    }
    const panel = vscode.window.createWebviewPanel(STATS_PANEL_TYPE, 'Contributor Stats', vscode.ViewColumn.Active, StatsPanel.options(extensionUri));
    StatsPanel.current = new StatsPanel(panel, extensionUri, stats, focusId);
  }

  /** Restores a panel after a window reload. */
  static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, stats: StatsService): void {
    panel.webview.options = StatsPanel.options(extensionUri);
    StatsPanel.current = new StatsPanel(panel, extensionUri, stats);
  }

  private static options(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly stats: StatsService,
    focusId?: string,
  ) {
    this.focusId = focusId;
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    panel.webview.html = webviewHtml(panel.webview, extensionUri, { title: 'Contributor Stats', script: 'stats.js', style: 'webview.css' });
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => void this.onMessage(m)),
      stats.onDidChange(() => this.post()),
    );
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.post();
        if (!this.stats.state.report && this.stats.state.status !== 'loading') await this.stats.refresh();
        return;
      case 'refresh':
        return this.stats.refresh();
      case 'filters':
        return void vscode.commands.executeCommand(Commands.setStatsFilters);
      case 'reviewAliases':
        return void vscode.commands.executeCommand(Commands.reviewAliases);
      case 'exportCsv':
        return void vscode.commands.executeCommand(Commands.exportStatsCsv);
      case 'exportMarkdown':
        return void vscode.commands.executeCommand(Commands.exportStatsMarkdown);
    }
  }

  private post(): void {
    if (!this.ready) return;
    const model = toViewModel(this.stats, this.focusId);
    this.panel.title = `Contributors: ${model.repoName}`;
    const message: HostToWebview = { type: 'update', model };
    void this.panel.webview.postMessage(message);
    this.focusId = undefined;
  }

  dispose(): void {
    if (StatsPanel.current === this) StatsPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

function toViewModel(stats: StatsService, focusId: string | undefined): StatsViewModel {
  const s = stats.state;
  const report = s.report;
  return {
    repoName: s.repo ? path.basename(s.repo.root) : 'No repository',
    status: report ? 'ready' : s.status === 'error' ? 'error' : s.repo ? 'loading' : 'empty',
    error: s.error,
    generatedAt: s.raw?.createdAt,
    fromCache: s.fromCache,
    stale: s.stale,
    shallow: s.shallow,
    filterSummary: describeFilter(s.filter, s.refLabel),
    filterActive: isFilterActive(s.filter),
    commitCount: s.raw?.commitCount ?? 0,
    hiddenBots: report?.hiddenBots ?? 0,
    suggestionCount: report?.suggestions.length ?? 0,
    totals: report?.totals ?? { commits: 0, merges: 0, added: 0, removed: 0, binaryFiles: 0 },
    contributors: (report?.contributors ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      emails: c.emails,
      commits: c.commits,
      merges: c.merges,
      added: c.added,
      removed: c.removed,
      binaryFiles: c.binaryFiles,
      firstDate: c.firstDate,
      lastDate: c.lastDate,
      activeDays: c.activeDays,
      weekly: c.weekly,
      identityCount: c.identities.length,
    })),
    focusId,
  };
}
