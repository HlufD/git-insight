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
} as const;

export const Views = {
  contributors: 'gitInsight.contributors',
} as const;

export const ContextKeys = {
  ready: 'gitInsight.ready',
  hasRepo: 'gitInsight.hasRepo',
  multiRepo: 'gitInsight.multiRepo',
} as const;

export const STATS_PANEL_TYPE = 'gitInsight.stats';
