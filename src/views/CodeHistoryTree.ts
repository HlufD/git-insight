import * as path from 'node:path';
import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { FileRef } from '../git/parsers/historyLog';
import { primaryFile, type CodeHistory, type Timeline, type TimelineEntry } from '../history/codeHistory';
import { SymbolKinds } from '../history/target';
import type { HistoryService } from '../services/HistoryService';
import { formatReadableDate } from '../stats/formatDate';

/** Arguments of the `openCommitDiff` command. */
export interface CommitDiffArgs {
  repoRoot: string;
  sha: string;
  parent?: string;
  subject: string;
  file: FileRef;
  /** Line to reveal in the commit's version. */
  line?: number;
}

export class CommitNode extends vscode.TreeItem {
  constructor(
    readonly entry: TimelineEntry,
    readonly repoRoot: string,
    readonly files: FileRef[],
    line: number | undefined,
    firstLabel: string,
  ) {
    super(entry.subject || '(no message)', files.length > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const date = formatReadableDate(entry.authorDate, { shortMonth: true });
    this.description = `${entry.firstAdded ? `${firstLabel} · ` : ''}${entry.authorName} · ${date} · ${entry.sha.slice(0, 7)}`;
    this.iconPath = new vscode.ThemeIcon(entry.firstAdded ? 'star-full' : entry.parents.length > 1 ? 'git-merge' : 'git-commit');
    this.contextValue = 'gitInsight.commit';

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${escape(entry.subject)}**\n\n`);
    tooltip.appendMarkdown(`$(person) ${escape(entry.authorName)} <${escape(entry.authorEmail)}>\n\n`);
    tooltip.appendMarkdown(`$(calendar) ${formatReadableDate(entry.authorDate, { weekday: true, time: true })} · \`${entry.authorDate}\`\n\n`);
    tooltip.appendMarkdown(`$(git-commit) \`${entry.sha}\``);
    if (entry.firstAdded) tooltip.appendMarkdown(`\n\n$(star-full) ${firstLabel}`);
    if (files.length) tooltip.appendMarkdown(`\n\n${files.map((f) => `- ${escape(describeFile(f))}`).join('\n')}`);
    this.tooltip = tooltip;

    if (files.length === 1) {
      this.command = diffCommand({ repoRoot, sha: entry.sha, parent: entry.parents[0], subject: entry.subject, file: files[0]!, line });
    }
  }
}

class FileNode extends vscode.TreeItem {
  constructor(args: CommitDiffArgs) {
    super(path.posix.basename(args.file.path), vscode.TreeItemCollapsibleState.None);
    this.description = `${path.posix.dirname(args.file.path)} · ${args.file.status}`;
    this.resourceUri = vscode.Uri.file(args.file.path);
    this.tooltip = describeFile(args.file);
    this.command = diffCommand(args);
  }
}

class SectionNode extends vscode.TreeItem {
  constructor(label: string, readonly timeline: Timeline, readonly firstLabel: string, readonly line: boolean, expanded: boolean) {
    super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${timeline.entries.length}${timeline.truncated ? '+' : ''} commit${timeline.entries.length === 1 ? '' : 's'}`;
  }
}

type Node = vscode.TreeItem;

/** WH-4: timeline of the selected code, plus commits on any branch that added or removed its name. */
export class CodeHistoryTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly subscription: vscode.Disposable;

  constructor(viewId: string, private readonly history: HistoryService) {
    this.view = vscode.window.createTreeView(viewId, { treeDataProvider: this });
    this.subscription = history.onDidChange(() => this.render());
  }

  private render(): void {
    const { request } = this.history.state;
    this.view.description = request ? `${request.target.label} · ${path.posix.basename(request.target.path)}` : undefined;
    this.view.message = request?.modified ? 'This file has uncommitted changes; history reflects the last commit.' : undefined;
    this.changed.fire();
  }

  getTreeItem(node: Node): Node {
    return node;
  }

  getChildren(parent?: Node): Node[] {
    const { status, request, result, error } = this.history.state;
    if (!request) return [];
    const repoRoot = request.repo.root;

    if (parent instanceof SectionNode) {
      const nodes: Node[] = parent.timeline.entries.map((e) => {
        const files = parent.line ? e.files.slice(0, 1) : pickFiles(e, request.target.path);
        return new CommitNode(e, repoRoot, files, parent.line ? e.line : undefined, parent.firstLabel);
      });
      if (parent.timeline.truncated) nodes.push(info(`Showing the newest ${parent.timeline.entries.length} commits`, 'ellipsis', 'Raise gitInsight.history.maxCommits to see more.'));
      return nodes;
    }
    if (parent instanceof CommitNode) {
      return parent.files.map((file) => new FileNode({ repoRoot, sha: parent.entry.sha, parent: parent.entry.parents[0], subject: parent.entry.subject, file }));
    }
    if (parent) return [];

    if (status === 'loading') return [info('Reading history…', 'loading~spin')];
    if (status === 'error' || !result) return [info(error ?? 'No history loaded', 'error')];
    return rootNodes(result, request.target.symbolKind);
  }

  dispose(): void {
    this.subscription.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}

function rootNodes(result: CodeHistory, symbolKind: number | undefined): Node[] {
  const nodes: Node[] = result.fallbackReasons.map((reason) => info(reason, 'info', reason));
  const kind = symbolKind === SymbolKinds.Class ? 'class' : result.name ? 'code' : 'lines';
  const label =
    result.mode === 'file'
      ? `History of ${path.posix.basename(result.path)}`
      : result.mode === 'function'
        ? `Changes to ${result.name}`
        : result.range && result.range.start === result.range.end
          ? `Changes to line ${result.range.start}`
          : `Changes to ${result.name ?? `lines ${result.range?.start}–${result.range?.end}`}`;
  const firstLabel = result.mode === 'file' ? 'file added' : `${kind} first added`;
  nodes.push(new SectionNode(label, result.history, firstLabel, result.mode !== 'file', true));
  if (result.history.entries.length === 0) nodes.push(info('No commits found', 'info'));

  if (result.pickaxe) {
    const section = new SectionNode(`Added or removed "${result.pickaxe.term}" (all branches)`, result.pickaxe, 'name first appeared', false, result.pickaxe.entries.length <= 30);
    section.tooltip = `Commits on any branch that changed how many times "${result.pickaxe.term}" appears (git log -S).`;
    nodes.push(section);
  }
  return nodes;
}

function pickFiles(entry: TimelineEntry, targetPath: string): FileRef[] {
  const main = primaryFile(entry, targetPath);
  return main ? [main, ...entry.files.filter((f) => f !== main)] : entry.files;
}

function diffCommand(args: CommitDiffArgs): vscode.Command {
  return { command: Commands.openCommitDiff, title: 'Open Diff', arguments: [args] };
}

function info(label: string, icon: string, tooltip?: string): Node {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.tooltip = tooltip;
  return item;
}

function describeFile(file: FileRef): string {
  return file.oldPath ? `${file.status}: ${file.oldPath} → ${file.path}` : `${file.status}: ${file.path}`;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|$]/g, '\\$&');
}
