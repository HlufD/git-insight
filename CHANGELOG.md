# Changelog

## 0.1.0 (unreleased)

### Added

- **Contributor Stats**: commits, merge commits, lines added/removed, binary files, first/last commit and active days per person across all branches.
- Alias suggestions by email, email name and fuzzy name matching; accept, split, rename or reject; saved to `.gitinsight/aliases.json`; export to `.mailmap`.
- Filters by date range, branch/tag and path globs.
- Stats panel with sortable table, top-contributor bar chart and weekly timeline, themed for light, dark and high contrast.
- CSV (Excel-ready) and Markdown export.
- Sidebar view of top contributors.
- Bot accounts hidden by default; generated files excluded from line counts.
- Cache keyed by refs, `.mailmap` and filters; cancellable scans.

### Planned

- Who wrote this and when? (code history for a function or selection)
- What happened on this date?
- Branch comparison for a file or function
- Explain business logic (optional, Claude API)
