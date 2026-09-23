import * as path from 'node:path';
import * as vscode from 'vscode';
import { readConfig } from '../config';
import { Views } from '../constants';
import { GitCancelledError, NotARepositoryError } from '../git/errors';
import { findRepository, type RepoLocation } from '../git/repository';
import { isModifiedSinceHead, loadCodeHistory, NotCommittedError, type CodeHistory } from '../history/codeHistory';
import { resolveTarget, type ResolvedTarget, type SimpleSymbol } from '../history/target';
import { showError } from './errorUi';
import type { RepoService } from './RepoService';

export interface HistoryRequest {
  repo: RepoLocation;
  document: vscode.Uri;
  target: ResolvedTarget;
  modified: boolean;
}

export interface HistoryState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  request?: HistoryRequest;
  result?: CodeHistory;
  error?: string;
}

/** Feature 2: "who wrote this and when?" for the code under the cursor or selection. */
export class HistoryService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private _state: HistoryState = { status: 'idle' };

  constructor(
    private readonly repos: RepoService,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  get state(): Readonly<HistoryState> {
    return this._state;
  }

  /** Resolves the target in the active editor and loads its history. */
  async whoWroteThis(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file and put the cursor in a function (or select some code) first.');
      return;
    }
    const document = editor.document;
    if (document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Save the file first: Git Insight reads history from the repository on disk.');
      return;
    }

    const repo = await findRepository(path.dirname(document.uri.fsPath));
    if (!repo) {
      await showError(new NotARepositoryError(path.dirname(document.uri.fsPath)), this.log);
      return;
    }
    const relative = path.relative(repo.root, document.uri.fsPath).split(path.sep).join('/');

    try {
      const runner = this.repos.runner(repo);
      const modified = document.isDirty || (await isModifiedSinceHead(runner, relative));
      const symbols = await documentSymbols(document.uri);
      const selection = editor.selection;
      const wordRange = document.getWordRangeAtPosition(selection.active);
      const target = resolveTarget({
        path: relative,
        symbols,
        selection: {
          startLine: selection.start.line,
          endLine: selection.end.line,
          endCharacter: selection.end.character,
          text: document.getText(selection),
        },
        wordAtCursor: wordRange ? document.getText(wordRange) : undefined,
        modified,
      });
      await this.load({ repo, document: document.uri, target, modified });
    } catch (error) {
      await this.fail(error, repo);
    }
  }

  /** Runs the last query again (after new commits, or a settings change). */
  async rerun(): Promise<void> {
    const request = this._state.request;
    if (!request) return this.whoWroteThis();
    try {
      const modified = await isModifiedSinceHead(this.repos.runner(request.repo), request.target.path);
      await this.load({ ...request, modified, target: { ...request.target, preferName: request.target.preferName || modified } });
    } catch (error) {
      await this.fail(error, request.repo);
    }
  }

  private async load(request: HistoryRequest): Promise<void> {
    const config = readConfig(vscode.Uri.file(request.repo.root));
    this.update({ status: 'loading', request, result: undefined, error: undefined });
    void vscode.commands.executeCommand(`${Views.codeHistory}.focus`);

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Git Insight: history of ${request.target.label}`, cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await loadCodeHistory({
            runner: this.repos.runner(request.repo),
            target: request.target,
            maxCommits: config.historyMaxCommits,
            pickaxe: config.historySearchAllBranches,
            signal: controller.signal,
          });
        } finally {
          subscription.dispose();
        }
      },
    );
    this.log.info(`History of ${request.target.label} in ${request.target.path}: ${result.mode} mode, ${result.history.entries.length} commits`);
    this.update({ status: 'ready', result });
  }

  private async fail(error: unknown, repo: RepoLocation): Promise<void> {
    if (error instanceof GitCancelledError) {
      this.update({ status: this._state.result ? 'ready' : 'idle' });
      return;
    }
    this.update({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    if (error instanceof NotCommittedError) {
      void vscode.window.showInformationMessage(error.message);
      return;
    }
    await showError(error, this.log, repo.root);
  }

  private update(patch: Partial<HistoryState>): void {
    this._state = { ...this._state, ...patch };
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Document symbols as plain data. Works with both DocumentSymbol trees and flat SymbolInformation lists. */
async function documentSymbols(uri: vscode.Uri): Promise<SimpleSymbol[]> {
  let raw: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
  try {
    raw = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
  } catch {
    raw = undefined;
  }
  const convert = (s: vscode.DocumentSymbol | vscode.SymbolInformation): SimpleSymbol => {
    const range = 'range' in s ? s.range : s.location.range;
    return {
      name: s.name,
      kind: s.kind, // SymbolKinds mirrors vscode.SymbolKind's values
      startLine: range.start.line,
      endLine: range.end.line,
      children: 'children' in s ? s.children.map(convert) : [],
    };
  };
  return (raw ?? []).map(convert);
}
