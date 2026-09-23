import * as path from 'node:path';
import * as vscode from 'vscode';
import { readConfig } from '../config';
import { Commands } from '../constants';
import { describeFilter, isFilterActive } from '../stats/filterSummary';
import { formatCount, formatReadableDate } from '../stats/formatDate';
import type { Contributor } from '../stats/report';
import type { AvatarService, PersonAvatar } from '../services/AvatarService';
import type { StatsService } from '../services/StatsService';
import { escapeMd, personTooltip } from './personTooltip';

type Node = vscode.TreeItem;

/** Sidebar list of top contributors (CS-10), plus status rows for suggestions, filters and errors. */
export class ContributorsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly subscriptions: vscode.Disposable[];

  constructor(viewId: string, private readonly stats: StatsService, private readonly avatars: AvatarService) {
    this.view = vscode.window.createTreeView(viewId, { treeDataProvider: this, showCollapseAll: false });
    this.subscriptions = [stats.onDidChange(() => this.render()), avatars.onDidChange(() => this.changed.fire())];
    this.render();
  }

  private render(): void {
    const { repo, stale } = this.stats.state;
    this.view.description = repo ? path.basename(repo.root) : undefined;
    this.view.message = stale ? 'History changed since the last scan. Refresh to update.' : undefined;
    this.changed.fire();
  }

  getTreeItem(node: Node): Node {
    return node;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    if (parent) return [];
    const state = this.stats.state;
    if (!state.repo) return [];

    if (!state.report) {
      if (state.status === 'idle' && this.view.visible) void this.stats.refresh();
      if (state.status === 'error') {
        return [action('Could not load stats', state.error, Commands.refreshContributors, 'error', 'Click to retry')];
      }
      if (state.status === 'idle') return [action('Load contributor stats', undefined, Commands.refreshContributors, 'play')];
      return [info('Reading history…', 'loading~spin')];
    }

    const { report } = state;
    const nodes: Node[] = [];
    if (state.shallow) nodes.push(info('Shallow clone: stats are incomplete', 'warning'));
    if (report.suggestions.length) {
      const n = report.suggestions.length;
      nodes.push(action(`${n} alias suggestion${n === 1 ? '' : 's'}`, 'Review', Commands.reviewAliases, 'person-add'));
    }
    if (isFilterActive(state.filter)) {
      nodes.push(action('Filtered', describeFilter(state.filter, state.refLabel), Commands.setStatsFilters, 'filter'));
    }

    const limit = readConfig(vscode.Uri.file(state.repo.root)).treeLimit;
    const top = report.contributors.slice(0, limit);
    const avatars = await Promise.all(top.map((c) => this.avatars.get(c.name, c.email)));
    top.forEach((c, i) => nodes.push(contributorNode(c, i + 1, avatars[i]!)));
    const more = report.contributors.length - limit;
    if (more > 0) nodes.push(action(`${more} more…`, undefined, Commands.showContributorStats, 'ellipsis'));
    if (report.contributors.length === 0) nodes.push(info('No commits match the current filters', 'info'));
    return nodes;
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.view.dispose();
    this.changed.dispose();
  }
}

function contributorNode(c: Contributor, rank: number, avatar: PersonAvatar): Node {
  const total = c.commits + c.merges;
  const item = new vscode.TreeItem(c.name);
  item.id = c.id;
  item.description = `${formatCount(total)} commit${total === 1 ? '' : 's'} · +${formatCount(c.added)} −${formatCount(c.removed)}`;
  item.iconPath = avatar.icon;
  item.contextValue = 'gitInsight.contributor';
  const tooltip = personTooltip(c.name, c.emails, avatar);
  tooltip.appendMarkdown(`---\n\n#${rank} by commits\n\n`);
  tooltip.appendMarkdown(
    [
      `| | |`,
      `|---|---:|`,
      `| Commits | ${c.commits} |`,
      `| Merge commits | ${c.merges} |`,
      `| Lines added / removed | +${c.added} / −${c.removed} |`,
      `| Binary files | ${c.binaryFiles} |`,
      `| Active days | ${c.activeDays} |`,
      `| First commit | ${formatReadableDate(c.firstDate, { shortMonth: true })} |`,
      `| Last commit | ${formatReadableDate(c.lastDate, { shortMonth: true })} |`,
    ].join('\n'),
  );
  if (c.identities.length > 1) tooltip.appendMarkdown(`\n\nGroups ${c.identities.length} identities: ${c.identities.map(escapeMd).join(', ')}`);
  item.tooltip = tooltip;
  item.command = { command: Commands.showContributorStats, title: 'Show Contributor Stats', arguments: [c.id] };
  return item;
}

function action(label: string, description: string | undefined, command: string, icon: string, tooltip?: string): Node {
  const item = new vscode.TreeItem(label);
  item.description = description;
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command, title: label };
  item.tooltip = tooltip ?? description;
  return item;
}

function info(label: string, icon: string): Node {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}
