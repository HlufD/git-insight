import * as path from 'node:path';
import * as vscode from 'vscode';
import { readConfig } from '../config';
import { ContextKeys } from '../constants';
import { GitRunner } from '../git/GitRunner';
import { findRepository, type RepoLocation } from '../git/repository';

const SELECTED_KEY = 'gitInsight.selectedRepo';

/**
 * Finds the repositories of the open workspace folders (one per folder, found by
 * walking up to `.git`; submodules are out of scope) and tracks the selected one.
 */
export class RepoService implements vscode.Disposable {
  private repos: RepoLocation[] = [];
  private selected: RepoLocation | undefined;
  private readonly changed = new vscode.EventEmitter<RepoLocation | undefined>();
  private readonly disposables: vscode.Disposable[] = [this.changed];

  /** Fires when the selected repository changes. */
  readonly onDidChangeRepository = this.changed.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()));
  }

  get current(): RepoLocation | undefined {
    return this.selected;
  }

  get all(): readonly RepoLocation[] {
    return this.repos;
  }

  async discover(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const found = await Promise.all(folders.map((f) => findRepository(f.uri.fsPath)));
    const byRoot = new Map<string, RepoLocation>();
    for (const repo of found) if (repo && !byRoot.has(repo.root)) byRoot.set(repo.root, repo);
    this.repos = [...byRoot.values()];

    const remembered = this.state.get<string>(SELECTED_KEY);
    const next = this.repos.find((r) => r.root === this.selected?.root) ?? this.repos.find((r) => r.root === remembered) ?? this.repos[0];
    await vscode.commands.executeCommand('setContext', ContextKeys.hasRepo, this.repos.length > 0);
    await vscode.commands.executeCommand('setContext', ContextKeys.multiRepo, this.repos.length > 1);
    await vscode.commands.executeCommand('setContext', ContextKeys.ready, true);
    this.log.info(`Found ${this.repos.length} repositor${this.repos.length === 1 ? 'y' : 'ies'}: ${this.repos.map((r) => r.root).join(', ') || 'none'}`);
    this.setSelected(next);
  }

  /** Quick-pick between the workspace's repositories. */
  async pick(): Promise<RepoLocation | undefined> {
    if (this.repos.length === 0) {
      void vscode.window.showWarningMessage('No Git repository found in this workspace.');
      return undefined;
    }
    const choice = await vscode.window.showQuickPick(
      this.repos.map((repo) => ({
        label: `$(repo) ${path.basename(repo.root)}`,
        description: repo.root === this.selected?.root ? 'current' : undefined,
        detail: repo.root,
        repo,
      })),
      { title: 'Git Insight: Select Repository', placeHolder: 'Which repository should Git Insight analyse?' },
    );
    if (choice) this.setSelected(choice.repo);
    return choice?.repo;
  }

  /** A git runner for the selected repo that logs every invocation. */
  runner(repo: RepoLocation): GitRunner {
    return new GitRunner(repo.root, {
      gitPath: readConfig(vscode.Uri.file(repo.root)).gitPath,
      onInvocation: ({ args, durationMs, exitCode }) =>
        this.log.info(`git ${args.map(printable).join(' ')} → exit ${exitCode ?? 'killed'} in ${durationMs} ms`),
    });
  }

  private setSelected(repo: RepoLocation | undefined): void {
    if (repo?.root === this.selected?.root) {
      this.selected = repo;
      return;
    }
    this.selected = repo;
    void this.state.update(SELECTED_KEY, repo?.root);
    this.changed.fire(repo);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Shows the record/field separators readably in the log. */
function printable(arg: string): string {
  return arg.replace(/[\x00-\x1f]/g, (c) => `%x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
