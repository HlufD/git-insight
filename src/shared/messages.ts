/** Data the stats webview renders. Kept small and serializable. */
export interface StatsViewModel {
  repoName: string;
  status: 'loading' | 'ready' | 'error' | 'empty';
  error?: string;
  generatedAt?: string;
  fromCache: boolean;
  stale: boolean;
  shallow: boolean;
  filterSummary: string;
  filterActive: boolean;
  commitCount: number;
  hiddenBots: number;
  suggestionCount: number;
  totals: { commits: number; merges: number; added: number; removed: number; binaryFiles: number };
  contributors: ContributorRow[];
  focusId?: string;
}

export interface ContributorRow {
  id: string;
  name: string;
  emails: string[];
  commits: number;
  merges: number;
  added: number;
  removed: number;
  binaryFiles: number;
  firstDate: string;
  lastDate: string;
  activeDays: number;
  weekly: Record<string, number>;
  identityCount: number;
}

export type HostToWebview = { type: 'update'; model: StatsViewModel };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'filters' }
  | { type: 'reviewAliases' }
  | { type: 'exportCsv' }
  | { type: 'exportMarkdown' };
