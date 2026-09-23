import { describe, expect, it } from 'vitest';
import { formatCount, formatReadableDate } from '../../src/stats/formatDate';
import { parseRefs } from '../../src/git/parsers/refs';

describe('formatReadableDate', () => {
  it('formats in the author timezone', () => {
    expect(formatReadableDate('2026-08-03T10:45:00+03:00', { weekday: true, time: true })).toBe('Mon, 3 August 2026, 10:45');
    expect(formatReadableDate('2026-08-03T23:30:00-07:00', { shortMonth: true })).toBe('3 Aug 2026');
    expect(formatReadableDate('2026-12-25', { time: true })).toBe('25 December 2026');
  });

  it('returns invalid input unchanged', () => {
    expect(formatReadableDate('yesterday')).toBe('yesterday');
    expect(formatReadableDate('2026-13-01')).toBe('2026-13-01');
  });
});

describe('formatCount', () => {
  it.each([[0, '0'], [950, '950'], [1000, '1k'], [1234, '1.2k'], [34_567, '35k'], [1_500_000, '1.5M'], [-2500, '-2.5k']])('%d → %s', (n, s) => {
    expect(formatCount(n)).toBe(s);
  });
});

describe('parseRefs', () => {
  it('classifies refs and skips symbolic remote HEAD', () => {
    const out = ['refs/heads/main\x1fmain', 'refs/remotes/origin/HEAD\x1forigin', 'refs/remotes/origin/dev\x1forigin/dev', 'refs/tags/v1.0\x1fv1.0', 'refs/stash\x1fstash', '', 'garbage'].join('\n');
    expect(parseRefs(out)).toEqual([
      { name: 'refs/heads/main', shortName: 'main', kind: 'branch' },
      { name: 'refs/remotes/origin/dev', shortName: 'origin/dev', kind: 'remote' },
      { name: 'refs/tags/v1.0', shortName: 'v1.0', kind: 'tag' },
    ]);
  });
});

import { describeFilter, isFilterActive } from '../../src/stats/filterSummary';

describe('filter summary', () => {
  it('describes default and custom filters', () => {
    expect(isFilterActive({})).toBe(false);
    expect(describeFilter({})).toBe('All branches · all time · all paths');
    const f = { ref: 'refs/remotes/origin/dev', until: '2026-09-01', paths: ['src/**', 'docs'] };
    expect(isFilterActive(f)).toBe(true);
    expect(describeFilter(f)).toBe('origin/dev · start → 2026-09-01 · src/**, docs');
    expect(describeFilter({ ref: 'refs/heads/main', since: '2026-01-01' }, 'main*')).toBe('main* · 2026-01-01 → now · all paths');
  });
});
