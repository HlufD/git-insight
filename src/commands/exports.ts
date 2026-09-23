import * as path from 'node:path';
import * as vscode from 'vscode';
import { toCsv, toMarkdown } from '../stats/export';
import { buildMailmapLines, mergeMailmap } from '../stats/mailmap';
import type { StatsService } from '../services/StatsService';
import { Commands } from '../constants';

/** CS-8: export the current report through a save dialog. */
export async function exportStats(stats: StatsService, format: 'csv' | 'markdown'): Promise<void> {
  const report = await stats.ensureReport();
  const { repo, filter, refLabel } = stats.state;
  if (!report || !repo) return;

  const ext = format === 'csv' ? 'csv' : 'md';
  const target = await vscode.window.showSaveDialog({
    title: `Export contributor stats as ${format === 'csv' ? 'CSV' : 'Markdown'}`,
    defaultUri: vscode.Uri.file(path.join(repo.root, `contributors-${new Date().toISOString().slice(0, 10)}.${ext}`)),
    filters: format === 'csv' ? { 'CSV (Excel)': ['csv'] } : { Markdown: ['md'] },
  });
  if (!target) return;

  const content = format === 'csv'
    ? toCsv(report.contributors)
    : toMarkdown(report.contributors, { repoName: path.basename(repo.root), generatedAt: new Date(), filter, refLabel });
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  const open = await vscode.window.showInformationMessage(`Exported ${report.contributors.length} contributors to ${path.basename(target.fsPath)}.`, 'Open');
  if (open) await vscode.commands.executeCommand('vscode.open', target);
}

/** CS-5: write confirmed alias groups as `.mailmap`, appending to an existing file. */
export async function exportMailmap(stats: StatsService): Promise<void> {
  const { repo, aliases } = stats.state;
  if (!repo) return;
  const lines = buildMailmapLines(aliases);
  if (lines.length === 0) {
    const choice = await vscode.window.showInformationMessage('There are no confirmed alias groups yet.', 'Review Suggestions');
    if (choice) await vscode.commands.executeCommand(Commands.reviewAliases);
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Export aliases as .mailmap',
    defaultUri: vscode.Uri.file(path.join(repo.root, '.mailmap')),
  });
  if (!target) return;

  let existing = '';
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
  } catch {
    // New file.
  }
  const merged = mergeMailmap(existing, lines);
  if (merged === existing) {
    void vscode.window.showInformationMessage(`${path.basename(target.fsPath)} already contains every alias.`);
    return;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(merged, 'utf8'));
  const open = await vscode.window.showInformationMessage(
    `Wrote ${lines.length} mailmap entr${lines.length === 1 ? 'y' : 'ies'}. Git now uses them in log, shortlog and blame.`,
    'Open',
  );
  if (open) await vscode.commands.executeCommand('vscode.open', target);
}
