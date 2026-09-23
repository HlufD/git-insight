import * as vscode from 'vscode';
import { AliasFileError, ALIAS_FILE_PATH } from '../stats/aliasFile';
import {
  EmptyRepositoryError, GitCancelledError, GitNotFoundError, NotARepositoryError,
} from '../git/errors';

/** Shows a clear message with a useful action button for each kind of failure. */
export async function showError(error: unknown, log: vscode.LogOutputChannel, repoRoot?: string): Promise<void> {
  if (error instanceof GitCancelledError) return;
  log.error(error instanceof Error ? error : String(error));

  if (error instanceof GitNotFoundError) {
    const choice = await vscode.window.showErrorMessage('Git not found. Install Git or set gitInsight.gitPath.', 'Open Settings', 'Download Git');
    if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'gitInsight.gitPath');
    if (choice === 'Download Git') await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'));
    return;
  }
  if (error instanceof NotARepositoryError) {
    const choice = await vscode.window.showErrorMessage('This folder is not a Git repository.', 'Initialize Repository');
    if (choice) await vscode.commands.executeCommand('git.init');
    return;
  }
  if (error instanceof EmptyRepositoryError) {
    void vscode.window.showInformationMessage('This repository has no commits yet. Make a first commit, then refresh Git Insight.');
    return;
  }
  if (error instanceof AliasFileError) {
    const choice = await vscode.window.showErrorMessage(`${error.message} Alias groups are ignored until it is fixed.`, 'Open File');
    if (choice && repoRoot) await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(repoRoot), ALIAS_FILE_PATH));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const choice = await vscode.window.showErrorMessage(`Git Insight: ${message}`, 'Show Log');
  if (choice) log.show();
}

const warnedShallow = new Set<string>();

/** Warns once per session that a shallow clone gives incomplete stats. */
export async function warnShallow(repoRoot: string): Promise<void> {
  if (warnedShallow.has(repoRoot)) return;
  warnedShallow.add(repoRoot);
  const choice = await vscode.window.showWarningMessage(
    'This is a shallow clone, so contributor stats only cover the history that was fetched.',
    'Fetch Full History',
  );
  if (choice) {
    const terminal = vscode.window.createTerminal({ name: 'Git Insight', cwd: repoRoot });
    terminal.show();
    // Typed but not run: the user presses Enter to confirm the network fetch.
    terminal.sendText('git fetch --unshallow', false);
  }
}
