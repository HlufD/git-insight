import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitUri } from '../providers/GitContentProvider';
import type { CommitDiffArgs, CommitNode } from '../views/CodeHistoryTree';

/**
 * WH-5/WH-6: diff of a file between a commit's first parent and the commit.
 * Added files and root commits diff against an empty file; deleted files against empty on the right.
 */
export async function openCommitDiff(args: CommitDiffArgs | undefined): Promise<void> {
  if (!args) return;
  const { repoRoot, sha, parent, file } = args;
  const short = sha.slice(0, 7);
  const leftRef = file.status === 'added' || !parent ? '' : parent;
  const rightRef = file.status === 'deleted' ? '' : sha;
  const left = gitUri(repoRoot, leftRef, file.oldPath ?? file.path);
  const right = gitUri(repoRoot, rightRef, file.path);
  const name = path.posix.basename(file.path);
  const title = `${name} (${leftRef ? `${short}^` : 'empty'} ↔ ${rightRef ? short : 'deleted'}) · ${args.subject}`;
  const options: vscode.TextDocumentShowOptions = { preview: true };
  if (args.line && args.line > 0) options.selection = new vscode.Range(args.line - 1, 0, args.line - 1, 0);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
}

export async function copyCommitSha(node: CommitNode | undefined): Promise<void> {
  if (!node?.entry) return;
  await vscode.env.clipboard.writeText(node.entry.sha);
  void vscode.window.setStatusBarMessage(`Copied ${node.entry.sha.slice(0, 7)}`, 2000);
}
