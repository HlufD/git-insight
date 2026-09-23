export const Commands = {
  selectRepository: 'gitInsight.selectRepository',
  showContributorStats: 'gitInsight.showContributorStats',
  refreshContributors: 'gitInsight.refreshContributors',
  setStatsFilters: 'gitInsight.setStatsFilters',
  reviewAliases: 'gitInsight.reviewAliases',
  exportMailmap: 'gitInsight.exportMailmap',
  exportStatsCsv: 'gitInsight.exportStatsCsv',
  exportStatsMarkdown: 'gitInsight.exportStatsMarkdown',
  clearCache: 'gitInsight.clearCache',
  whoWroteThis: 'gitInsight.whoWroteThis',
  refreshCodeHistory: 'gitInsight.refreshCodeHistory',
  openCommitDiff: 'gitInsight.openCommitDiff',
  copyCommitSha: 'gitInsight.copyCommitSha',
} as const;

export const Views = {
  contributors: 'gitInsight.contributors',
  codeHistory: 'gitInsight.codeHistory',
} as const;

export const ContextKeys = {
  ready: 'gitInsight.ready',
  hasRepo: 'gitInsight.hasRepo',
  multiRepo: 'gitInsight.multiRepo',
} as const;

export const STATS_PANEL_TYPE = 'gitInsight.stats';

/** URI scheme for file contents at a commit (`git show <ref>:<path>`). */
export const GIT_SCHEME = 'gitinsight';
