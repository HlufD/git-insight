import { describe, expect, it } from 'vitest';
import { StatsAccumulator } from '../../src/stats/accumulator';
import { acceptGroup, emptyAliasFile } from '../../src/stats/aliasFile';
import { isIsoDay, localDay, weekRange, weekStart } from '../../src/stats/dates';
import { parseLogNumstat } from '../../src/git/parsers/logNumstat';
import { createPathMatcher, toGlobPathspecs } from '../../src/stats/pathFilter';
import { buildReport } from '../../src/stats/report';
import { RAW_STATS_SCHEMA, type RawStats } from '../../src/stats/types';
import { fixture } from '../helpers';

const EXCLUDE = ['**/package-lock.json', '**/dist/**', '**/*.min.js'];

function rawFrom(commits = parseLogNumstat(fixture('log-numstat.txt')), options = {}): RawStats {
  const acc = new StatsAccumulator({ isExcludedPath: createPathMatcher(EXCLUDE), ...options });
  commits.forEach((c) => acc.add(c));
  return { schema: RAW_STATS_SCHEMA, fingerprint: 'f', filter: {}, createdAt: '', commitCount: acc.commitCount, identities: acc.result() };
}

describe('dates', () => {
  it('uses the author-local day, not UTC', () => {
    expect(localDay('2026-08-03T23:30:00-07:00')).toBe('2026-08-03');
  });

  it('finds ISO week Mondays', () => {
    expect(weekStart('2026-08-03')).toBe('2026-08-03'); // Monday
    expect(weekStart('2026-08-09')).toBe('2026-08-03'); // Sunday
    expect(weekStart('2027-01-01')).toBe('2026-12-28');
    expect(weekRange('2026-08-03', '2026-08-17')).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
  });

  it('validates ISO days', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('3 Aug 2026')).toBe(false);
  });
});

describe('path filters', () => {
  it('matches globs including dotfiles and never matches with no globs', () => {
    const m = createPathMatcher(['**/dist/**', ' ', '.github/**']);
    expect(m('packages/a/dist/x.js')).toBe(true);
    expect(m('.github/workflows/ci.yml')).toBe(true);
    expect(m('src/dist.ts')).toBe(false);
    expect(createPathMatcher([])('anything')).toBe(false);
  });

  it('turns globs into git glob pathspecs with forward slashes', () => {
    expect(toGlobPathspecs(['src\\**\\*.ts', '', 'docs'])).toEqual([':(glob)src/**/*.ts', ':(glob)docs']);
  });
});

describe('StatsAccumulator', () => {
  const raw = rawFrom();
  const bewuket = raw.identities.find((s) => s.name === 'Bewuket Baye')!;
  const john = raw.identities.find((s) => s.name === 'Smith, John')!;

  it('splits merge and non-merge commits', () => {
    expect(bewuket).toMatchObject({ commits: 1, merges: 1 });
    expect(raw.commitCount).toBe(4);
  });

  it('counts lines, skips excluded paths, and counts binary files separately', () => {
    expect(bewuket).toMatchObject({ added: 10, removed: 2, binaryFiles: 1 });
    const zoe = raw.identities.find((s) => s.name === 'Zoë Ünïcode')!;
    expect(zoe).toMatchObject({ added: 4, removed: 1 });
  });

  it('tracks first/last dates, active days and weekly counts', () => {
    expect(bewuket.firstDate).toBe('2026-08-03T10:45:00+03:00');
    expect(bewuket.lastDate).toBe('2026-08-10T09:00:00+03:00');
    expect(bewuket.days).toEqual(['2026-08-03', '2026-08-10']);
    expect(bewuket.weekly).toEqual({ '2026-08-03': 1, '2026-08-10': 1 });
    expect(john.days).toEqual(['2026-08-03']);
  });

  it('applies the date filter to author-local days and skips invalid dates', () => {
    const commits = parseLogNumstat(fixture('log-numstat.txt'));
    commits.push({ ...commits[0]!, sha: 'f'.repeat(40), authorDate: 'garbage' });
    const filtered = rawFrom(commits, { since: '2026-08-04', until: '2026-08-10' });
    expect(filtered.commitCount).toBe(1);
    expect(filtered.identities.map((s) => s.name)).toEqual(['Bewuket Baye']);
  });

  it('keeps earliest and latest when commits arrive out of order', () => {
    const commits = parseLogNumstat(fixture('log-numstat.txt')).reverse();
    const s = rawFrom(commits).identities.find((x) => x.name === 'Bewuket Baye')!;
    expect(s.firstDate).toBe('2026-08-03T10:45:00+03:00');
    expect(s.lastDate).toBe('2026-08-10T09:00:00+03:00');
  });
});

describe('buildReport', () => {
  const raw = rawFrom();
  const bot = { ...raw.identities[0]!, id: 'dependabot[bot] <bot@x>', name: 'dependabot[bot]', email: 'bot@x', commits: 50 };
  const withBot: RawStats = { ...raw, identities: [...raw.identities, bot] };
  const options = { excludeBots: true, botPatterns: ['\\[bot\\]', '('] };

  it('sorts by total commits, hides bots, and reports invalid patterns', () => {
    const report = buildReport(withBot, emptyAliasFile(), options);
    expect(report.contributors.map((c) => c.name)).toEqual(['Bewuket Baye', 'Smith, John', 'Zoë Ünïcode']);
    expect(report.hiddenBots).toBe(1);
    expect(report.invalidBotPatterns).toEqual(['(']);
    expect(report.totals).toEqual({ commits: 3, merges: 1, added: 22, removed: 9, binaryFiles: 1 });
  });

  it('can include bots', () => {
    const report = buildReport(withBot, emptyAliasFile(), { ...options, excludeBots: false });
    expect(report.contributors[0]).toMatchObject({ name: 'dependabot[bot]', bot: true });
    expect(report.hiddenBots).toBe(0);
  });

  it('merges confirmed alias groups', () => {
    const ids = raw.identities.filter((s) => s.name !== 'Zoë Ünïcode').map((s) => s.id);
    const aliases = acceptGroup(emptyAliasFile(), [...ids, 'Missing <m@x>'], 'Team B', 'team@x.com');
    const report = buildReport(raw, aliases, options);
    const group = report.contributors[0]!;
    expect(group).toMatchObject({ id: 'group:0', name: 'Team B', commits: 2, merges: 1, activeDays: 2, identities: [...ids].sort() });
    expect(group.emails).toEqual(['bewuket@example.com', 'john@example.com']);
    expect(group.weekly).toEqual({ '2026-08-03': 2, '2026-08-10': 1 });
    expect(group.firstDate).toBe('2026-08-03T10:45:00+03:00');
    expect(group.lastDate).toBe('2026-08-10T09:00:00+03:00');
  });

  it('ignores groups whose members are all absent', () => {
    const aliases = acceptGroup(emptyAliasFile(), ['X <x@x>', 'Y <y@y>'], 'Ghost', 'g@x');
    expect(buildReport(raw, aliases, options).contributors).toHaveLength(3);
  });
});
