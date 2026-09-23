import * as path from 'node:path';
import * as vscode from 'vscode';
import { StatsCache } from '../cache/StatsCache';
import { readConfig } from '../config';
import { GitCancelledError } from '../git/errors';
import { isShallowRepository, type RepoLocation } from '../git/repository';
import { ALIAS_FILE_PATH, AliasFileError, emptyAliasFile, readAliasFile, writeAliasFile, type AliasFile } from '../stats/aliasFile';
import { buildReport, type StatsReport } from '../stats/report';
import { loadRawStats } from '../stats/scan';
import type { RawStats, StatsFilter } from '../stats/types';
import { showError, warnShallow } from './errorUi';
import type { RepoService } from './RepoService';

export type StatsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface StatsState {
  repo?: RepoLocation;
  status: StatsStatus;
  raw?: RawStats;
  report?: StatsReport;
  aliases: AliasFile;
  aliasError?: string;
  error?: string;
  fromCache: boolean;
  /** Refs changed since the last scan. */
  stale: boolean;
  shallow: boolean;
  filter: StatsFilter;
  /** Short display name of `filter.ref`. */
  refLabel?: string;
}

const FILTER_KEY = 'gitInsight.statsFilter:';

/**
 * Owns contributor-stats state for the selected repository: filters, alias file,
 * cached scans and the report built from them. Views listen to `onDidChange`.
 */
export class StatsService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private readonly cache: StatsCache;
  private repoDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private inflight: Promise<void> | undefined;
  private _state: StatsState = this.initialState(undefined);

  constructor(
    private readonly repos: RepoService,
    private readonly workspaceState: vscode.Memento,
    storageDir: string,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.cache = new StatsCache(storageDir);
    this.disposables.push(
      repos.onDidChangeRepository((repo) => void this.switchRepository(repo)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitInsight.stats.excludePaths') || e.affectsConfiguration('gitInsight.gitPath')) {
          void this.refresh();
        } else if (e.affectsConfiguration('gitInsight.stats')) {
          this.rebuild();
        }
      }),
    );
    void this.switchRepository(repos.current);
  }

  get state(): Readonly<StatsState> {
    return this._state;
  }

  /**
   * Loads stats (from cache when possible) with a cancellable progress
   * notification. Concurrent calls share one scan.
   */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** Makes sure a report exists; returns it, or undefined if loading failed or was cancelled. */
  async ensureReport(): Promise<StatsReport | undefined> {
    if (!this._state.report || this._state.stale) await this.refresh();
    return this._state.report;
  }

  async setFilter(filter: StatsFilter, refLabel?: string): Promise<void> {
    const repo = this._state.repo;
    if (!repo) return;
    const clean: StatsFilter = {
      since: filter.since || undefined,
      until: filter.until || undefined,
      ref: filter.ref || undefined,
      paths: filter.paths?.length ? filter.paths : undefined,
    };
    await this.workspaceState.update(FILTER_KEY + repo.root, { filter: clean, refLabel });
    this.update({ filter: clean, refLabel: clean.ref ? refLabel : undefined });
    await this.refresh();
  }

  /** Applies an edit to `.gitinsight/aliases.json`, saves it and rebuilds the report (no git call). */
  async updateAliases(edit: (file: AliasFile) => AliasFile): Promise<void> {
    const repo = this._state.repo;
    if (!repo) return;
    if (this._state.aliasError) {
      await showError(new AliasFileError(this._state.aliasError), this.log, repo.root);
      return;
    }
    const next = edit(this._state.aliases);
    await writeAliasFile(repo.root, next);
    this.update({ aliases: next });
    this.rebuild();
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
    this.update({ raw: undefined, report: undefined, status: 'idle', fromCache: false });
  }

  private initialState(repo: RepoLocation | undefined): StatsState {
    const saved = repo ? this.workspaceState.get<{ filter: StatsFilter; refLabel?: string }>(FILTER_KEY + repo.root) : undefined;
    return {
      repo,
      status: 'idle',
      aliases: emptyAliasFile(),
      fromCache: false,
      stale: false,
      shallow: false,
      filter: saved?.filter ?? {},
      refLabel: saved?.refLabel,
    };
  }

  private async switchRepository(repo: RepoLocation | undefined): Promise<void> {
    this.repoDisposables.forEach((d) => d.dispose());
    this.repoDisposables = [];
    this._state = this.initialState(repo);
    this.changed.fire();
    if (!repo) return;

    await this.reloadAliases();
    const root = vscode.Uri.file(repo.root);

    const aliasWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ALIAS_FILE_PATH));
    const onAliasFile = () => void this.reloadAliases().then(() => this.rebuild());
    aliasWatcher.onDidChange(onAliasFile);
    aliasWatcher.onDidCreate(onAliasFile);
    aliasWatcher.onDidDelete(onAliasFile);

    // Any ref or .mailmap change means the scan is out of date. We only flag it;
    // rescanning on every commit would be wasteful on large repositories.
    const markStale = () => {
      if (this._state.raw && !this._state.stale) this.update({ stale: true });
    };
    const gitWatchers = [
      new vscode.RelativePattern(vscode.Uri.file(repo.gitDir), 'HEAD'),
      new vscode.RelativePattern(vscode.Uri.file(repo.commonDir), '{packed-refs,refs/**}'),
      new vscode.RelativePattern(root, '.mailmap'),
    ].map((pattern) => {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(markStale);
      watcher.onDidCreate(markStale);
      watcher.onDidDelete(markStale);
      return watcher;
    });
    this.repoDisposables.push(aliasWatcher, ...gitWatchers);
  }

  private async reloadAliases(): Promise<void> {
    const repo = this._state.repo;
    if (!repo) return;
    try {
      this.update({ aliases: await readAliasFile(repo.root), aliasError: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update({ aliases: emptyAliasFile(), aliasError: message });
      await showError(error instanceof AliasFileError ? error : new AliasFileError(message), this.log, repo.root);
    }
  }

  private async load(): Promise<void> {
    const repo = this._state.repo;
    if (!repo) return;
    const config = readConfig(vscode.Uri.file(repo.root));
    const filter = this._state.filter;
    this.update({ status: 'loading', error: undefined });

    try {
      const shallow = await isShallowRepository(repo);
      if (shallow) void warnShallow(repo.root);

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Git Insight: reading history of ${path.basename(repo.root)}`,
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            return await loadRawStats({
              repo,
              runner: this.repos.runner(repo),
              filter,
              excludePaths: config.excludePaths,
              cache: this.cache,
              signal: controller.signal,
              onProgress: (n) => progress.report({ message: `${n.toLocaleString()} commits` }),
            });
          } finally {
            subscription.dispose();
          }
        },
      );
      if (this._state.repo !== repo) return; // repository switched meanwhile
      this.log.info(`Stats for ${repo.root}: ${result.stats.commitCount} commits, ${result.stats.identities.length} identities${result.fromCache ? ' (cache)' : ''}`);
      this.update({ raw: result.stats, fromCache: result.fromCache, stale: false, shallow, status: 'ready' });
      this.rebuild();
    } catch (error) {
      if (this._state.repo !== repo) return;
      if (error instanceof GitCancelledError) {
        this.update({ status: this._state.report ? 'ready' : 'idle' });
        void vscode.window.showInformationMessage('Git Insight: scan cancelled.');
        return;
      }
      this.update({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      await showError(error, this.log, repo.root);
    }
  }

  /** Recomputes the report from the last scan (aliases, bots, threshold). */
  private rebuild(): void {
    const { raw, repo } = this._state;
    if (!raw || !repo) return;
    const config = readConfig(vscode.Uri.file(repo.root));
    const report = buildReport(raw, this._state.aliases, {
      excludeBots: config.excludeBots,
      botPatterns: config.botPatterns,
      aliasThreshold: config.aliasThreshold,
    });
    if (report.invalidBotPatterns.length) {
      this.log.warn(`Ignoring invalid gitInsight.stats.botPatterns: ${report.invalidBotPatterns.join(', ')}`);
    }
    this.update({ report });
  }

  private update(patch: Partial<StatsState>): void {
    this._state = { ...this._state, ...patch };
    this.changed.fire();
  }

  dispose(): void {
    this.repoDisposables.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
