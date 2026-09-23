import { describe, expect, it } from 'vitest';
import { unquoteCPath } from '../../src/git/parsers/cQuote';
import { LogNumstatParser, parseLogNumstat, parseNumstatLine, resolveRenamedPath } from '../../src/git/parsers/logNumstat';
import { fixture } from '../helpers';

describe('parseLogNumstat', () => {
  const commits = parseLogNumstat(fixture('log-numstat.txt'));

  it('parses every commit header', () => {
    expect(commits.map((c) => c.sha[0])).toEqual(['1', '2', '3', '4']);
    expect(commits[0]).toMatchObject({ authorName: 'Bewuket Baye', authorEmail: 'bewuket@example.com', authorDate: '2026-08-03T10:45:00+03:00', parents: [] });
  });

  it('keeps names with commas and unicode intact', () => {
    expect(commits[1]!.authorName).toBe('Smith, John');
    expect(commits[3]!.authorName).toBe('Zoë Ünïcode');
  });

  it('marks binary files and gives them zero lines', () => {
    expect(commits[0]!.files[1]).toEqual({ path: 'assets/logo.png', added: 0, removed: 0, binary: true });
  });

  it('resolves renames and quoted paths', () => {
    expect(commits[1]!.files.map((f) => f.path)).toEqual(['src/new/util.ts', 'docs/b.md', 'src/café.ts']);
    expect(commits[3]!.files[1]!.path).toBe('src/lib/x.ts');
  });

  it('parses merge commits with two parents and no files', () => {
    expect(commits[2]!.parents).toHaveLength(2);
    expect(commits[2]!.files).toEqual([]);
  });

  it('returns nothing for empty output', () => {
    expect(parseLogNumstat(fixture('empty.txt'))).toEqual([]);
  });

  it('counts malformed headers and ignores lines before the first commit', () => {
    const parser = new LogNumstatParser();
    expect(parser.push('1\t1\tstray.ts')).toBeUndefined();
    expect(parser.push('\x1enot-a-sha\x1f\x1fX\x1fx@x\x1f2026-01-01T00:00:00Z\x1f')).toBeUndefined();
    expect(parser.push('\x1etoo\x1ffew')).toBeUndefined();
    expect(parser.malformed).toBe(2);
    expect(parser.end()).toBeUndefined();
  });

  it('accepts SHA-256 object names and CRLF input', () => {
    const sha256 = 'a'.repeat(64);
    const text = `\x1e${sha256}\x1f\x1fA\x1fa@x\x1f2026-01-01T00:00:00Z\x1f\r\n\r\n1\t2\tf.txt\r\n`;
    expect(parseLogNumstat(text)[0]).toMatchObject({ sha: sha256, files: [{ path: 'f.txt', added: 1, removed: 2 }] });
  });
});

describe('parseNumstatLine', () => {
  it('rejects non-numstat lines', () => {
    expect(parseNumstatLine('hello')).toBeUndefined();
    expect(parseNumstatLine('1\t2')).toBeUndefined();
  });

  it('keeps tabs inside file names', () => {
    expect(parseNumstatLine('1\t2\ta\tb.txt')?.path).toBe('a\tb.txt');
  });
});

describe('resolveRenamedPath', () => {
  it.each([
    ['a.txt', 'a.txt'],
    ['old.txt => new.txt', 'new.txt'],
    ['src/{a => b}/c.ts', 'src/b/c.ts'],
    ['src/{a => }/c.ts', 'src/c.ts'],
    ['{src => lib}/c.ts', 'lib/c.ts'],
    ['{ => lib}/c.ts', 'lib/c.ts'],
  ])('%s → %s', (input, expected) => {
    expect(resolveRenamedPath(input)).toBe(expected);
  });
});

describe('unquoteCPath', () => {
  it('leaves unquoted paths alone', () => {
    expect(unquoteCPath('plain.txt')).toBe('plain.txt');
    expect(unquoteCPath('"')).toBe('"');
  });

  it('decodes octal UTF-8 bytes and escapes', () => {
    expect(unquoteCPath('"\\303\\251t\\303\\251.txt"')).toBe('été.txt');
    expect(unquoteCPath('"a\\tb\\n\\"q\\"\\\\"')).toBe('a\tb\n"q"\\');
    expect(unquoteCPath('"\\a\\b\\f\\r\\v"')).toBe('\x07\b\f\r\v');
  });

  it('keeps unknown escapes and a trailing backslash literally', () => {
    expect(unquoteCPath('"a\\qb"')).toBe('a\\qb');
    expect(unquoteCPath('"a\\"')).toBe('a\\');
  });
});
