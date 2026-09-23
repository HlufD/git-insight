import { describe, expect, it } from 'vitest';
import { parseHistoryHeader, parseLineLog, parseNameStatusLog } from '../../src/git/parsers/historyLog';
import { escapeFuncname, isSearchableName, primaryFile } from '../../src/history/codeHistory';
import { fixture } from '../helpers';

describe('parseLineLog', () => {
  const [newest, oldest] = parseLineLog(fixture('line-log.txt'));

  it('parses headers, keeping separators inside the subject', () => {
    expect(newest).toMatchObject({ authorName: 'Smith, John', authorDate: '2026-08-03T10:45:00+03:00', subject: 'Fix total\x1fwith \x1f in subject', parents: ['b'.repeat(40)] });
    expect(oldest!.parents).toEqual([]);
  });

  it('detects renames and ignores content lines that look like headers', () => {
    expect(newest!.files).toEqual([{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }]);
    expect(newest!.hunks).toEqual([{ oldStart: 10, oldCount: 3, newStart: 12, newCount: 4 }]);
  });

  it('marks added files, unquotes paths and defaults hunk counts to 1', () => {
    expect(oldest!.files).toEqual([{ path: 'src/café.ts', status: 'added' }]);
    expect(oldest!.hunks).toEqual([{ oldStart: 0, oldCount: 0, newStart: 10, newCount: 1 }]);
  });

  it('marks deleted files and handles empty or malformed input', () => {
    const text = '\x1e' + 'd'.repeat(40) + '\x1f\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1fDelete\n\ndiff --git a/x b/x\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    expect(parseLineLog(text)[0]!.files).toEqual([{ path: 'x', status: 'deleted' }]);
    expect(parseLineLog('')).toEqual([]);
    expect(parseLineLog('\x1enot-a-sha\x1f\x1fA\x1fa\x1fd\x1fs\nstray')).toEqual([]);
  });

  it('keeps CRLF output working', () => {
    const text = fixture('line-log.txt').replace(/\n/g, '\r\n');
    expect(parseLineLog(text)[0]!.files[0]!.path).toBe('src/new.ts');
  });
});

describe('parseNameStatusLog', () => {
  const [move, initial] = parseNameStatusLog(fixture('name-status-log.txt'));

  it('parses every status letter', () => {
    expect(move!.files).toEqual([
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' },
      { path: 'docs/été.md', status: 'modified' },
      { path: 'gone.txt', status: 'deleted' },
      { path: 'b.txt', oldPath: 'a.txt', status: 'copied' },
      { path: 'link', status: 'type-changed' },
    ]);
    expect(initial!.files).toEqual([{ path: 'src/old.ts', status: 'added' }]);
  });

  it('picks the file that matches a path, or the only file', () => {
    expect(primaryFile(move!, 'src/old.ts')?.path).toBe('src/new.ts');
    expect(primaryFile(move!, 'nope')).toBeUndefined();
    expect(primaryFile(initial!, 'anything')?.path).toBe('src/old.ts');
  });
});

describe('helpers', () => {
  it('rejects short headers', () => {
    expect(parseHistoryHeader('a\x1fb')).toBeUndefined();
  });

  it('escapes basic-regex specials only', () => {
    expect(escapeFuncname('$scope.get*')).toBe('\\$scope\\.get\\*');
    expect(escapeFuncname('a(b)+c?')).toBe('a(b)+c?');
    expect(escapeFuncname('x[0]^\\')).toBe('x\\[0\\]\\^\\\\');
  });

  it.each([
    ['getUser', true], ['$', false], ['x', false], ['a\nb', false], ['---', false], ['Foo::bar', true], ['a'.repeat(201), false], [undefined, false],
  ])('isSearchableName(%j) → %s', (name, expected) => {
    expect(isSearchableName(name)).toBe(expected);
  });
});
