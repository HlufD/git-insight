import { describe, expect, it } from 'vitest';
import { acceptGroup, emptyAliasFile } from '../../src/stats/aliasFile';
import { toCsv, toMarkdown } from '../../src/stats/export';
import { buildMailmapLines, mergeMailmap } from '../../src/stats/mailmap';
import type { Contributor } from '../../src/stats/report';

const contributor = (overrides: Partial<Contributor> = {}): Contributor => ({
  id: 'x', name: 'Smith, "Johnny"', email: 'j@x.com', emails: ['j@x.com', 'js@y.com'], identities: [],
  commits: 12, merges: 1, added: 100, removed: 20, binaryFiles: 2,
  firstDate: '2026-01-02T03:04:05+03:00', firstTimestamp: 0, lastDate: '2026-08-03T10:45:00+03:00', lastTimestamp: 0,
  activeDays: 7, weekly: {}, bot: false, ...overrides,
});

describe('toCsv', () => {
  const csv = toCsv([contributor(), contributor({ name: '=HYPERLINK("x")', emails: [] })]);

  it('starts with a UTF-8 BOM and uses CRLF', () => {
    expect(csv.startsWith('﻿"Name","Emails"')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(4);
  });

  it('quotes every field and doubles inner quotes', () => {
    expect(csv).toContain('"Smith, ""Johnny""","j@x.com; js@y.com","12","1","100","20","2"');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('toMarkdown', () => {
  it('writes a header, filters and an escaped table', () => {
    const md = toMarkdown([contributor({ name: 'A | B <script>' })], {
      repoName: 'demo', generatedAt: new Date('2026-09-23T00:00:00Z'), filter: { since: '2026-01-01', paths: ['src/**'] }, refLabel: 'main',
    });
    expect(md).toContain('# Contributor stats — demo');
    expect(md).toContain('- Branch: main');
    expect(md).toContain('- Date range: 2026-01-01 → now');
    expect(md).toContain('- Paths: `src/**`');
    expect(md).toContain('| A \\| B &lt;script&gt; |');
    expect(md).toContain('| --- | --- | ---: |');
  });

  it('defaults to all branches without path filters', () => {
    const md = toMarkdown([], { repoName: 'r', generatedAt: new Date(0), filter: {} });
    expect(md).toContain('- Branch: all branches');
    expect(md).toContain('start → now');
    expect(md).not.toContain('Paths');
  });
});

describe('mailmap', () => {
  const aliases = acceptGroup(emptyAliasFile(), ['bewuket <b1@laptop>', 'Bewuket Baye <bewuket@co.com>', 'bewuket0 <B1@laptop>'], 'Bewuket Baye', 'Bewuket@co.com');

  it('maps each commit email once to the canonical identity', () => {
    expect(buildMailmapLines(aliases)).toEqual([
      'Bewuket Baye <Bewuket@co.com>',
      'Bewuket Baye <Bewuket@co.com> <b1@laptop>',
    ]);
  });

  it('appends only new lines to an existing .mailmap', () => {
    const lines = buildMailmapLines(aliases);
    expect(mergeMailmap('', lines)).toBe(`# Added by Git Insight\n${lines.join('\n')}\n`);
    const existing = `Someone <s@x>\n${lines[0]}`;
    expect(mergeMailmap(existing, lines)).toBe(`${existing}\n\n# Added by Git Insight\n${lines[1]}\n`);
    expect(mergeMailmap(`${lines.join('\n')}\n`, lines)).toBe(`${lines.join('\n')}\n`);
  });
});
