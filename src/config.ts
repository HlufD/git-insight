import * as vscode from 'vscode';

export interface GitInsightConfig {
  gitPath: string;
  excludeBots: boolean;
  botPatterns: string[];
  excludePaths: string[];
  aliasThreshold: number;
  treeLimit: number;
}

export function readConfig(scope?: vscode.Uri): GitInsightConfig {
  const c = vscode.workspace.getConfiguration('gitInsight', scope);
  return {
    gitPath: c.get<string>('gitPath', '').trim(),
    excludeBots: c.get<boolean>('stats.excludeBots', true),
    botPatterns: c.get<string[]>('stats.botPatterns', []),
    excludePaths: c.get<string[]>('stats.excludePaths', []),
    aliasThreshold: clamp(c.get<number>('stats.aliasSimilarityThreshold', 0.9), 0.7, 1),
    treeLimit: Math.max(1, Math.floor(c.get<number>('stats.treeLimit', 20))),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
