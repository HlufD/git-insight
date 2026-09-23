import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRunner } from '../../src/git/GitRunner';
import { isModifiedSinceHead, loadCodeHistory, NotCommittedError } from '../../src/history/codeHistory';
import { TempRepo } from './gitRepo';

const v1 = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}
`;
const v2 = v1.replace('return a + b;', 'const sum = a + b;\n  return sum;');
const v3 = `// header comment\n${v2.replace('return a - b;', 'return a - b; // subtract')}`;

describe('loadCodeHistory', () => {
  let repo: TempRepo;
  let runner: GitRunner;

  beforeAll(() => {
    repo = new TempRepo();
    repo.commit('Ann <ann@x>', { 'src/math.js': v1, 'other.js': 'const x = 1;\n' }, '2026-08-01T10:00:00+03:00');
    repo.commit('Bob <bob@x>', { 'src/math.js': v2 }, '2026-08-02T10:00:00+03:00');
    repo.git('mv', 'src/math.js', 'src/calc.js');
    repo.commit('Cid <cid@x>', {}, '2026-08-03T10:00:00+03:00');
    repo.commit('Dee <dee@x>', { 'src/calc.js': v3 }, '2026-08-04T10:00:00+03:00');
    repo.git('checkout', '-q', '-b', 'side');
    repo.commit('Eve <eve@x>', { 'side.js': 'add(1, 2);\n' }, '2026-08-05T10:00:00+03:00');
    repo.git('checkout', '-q', 'main');
    runner = new GitRunner(repo.root);
  });
  afterAll(() => repo.remove());

  it('follows a function by line range across a rename and marks where it was added', async () => {
    // In HEAD, add() is on lines 2–5 (after the header comment).
    const h = await loadCodeHistory({ runner, target: { path: 'src/calc.js', name: 'add', range: { start: 2, end: 5 } }, maxCommits: 50, pickaxe: false });
    expect(h.mode).toBe('range');
    expect(h.fallbackReasons).toEqual([]);
    expect(h.history.entries.map((e) => e.authorName)).toEqual(['Bob', 'Ann']);
    expect(h.history.entries[0]!.files[0]).toMatchObject({ path: 'src/math.js' });
    expect(h.history.entries[1]).toMatchObject({ firstAdded: true, files: [{ status: 'added' }], line: 1 });
    expect(h.history.truncated).toBe(false);
  });

  it('uses the function name first when the working file changed', async () => {
    const h = await loadCodeHistory({ runner, target: { path: 'src/calc.js', name: 'sub', range: { start: 90, end: 95 }, preferName: true }, maxCommits: 50, pickaxe: false });
    expect(h.mode).toBe('function');
    expect(h.history.entries.map((e) => e.authorName)).toEqual(['Dee', 'Ann']);
  });

  it('falls back from an unknown function to the line range, with a reason', async () => {
    const h = await loadCodeHistory({ runner, target: { path: 'src/calc.js', name: 'nope', range: { start: 1, end: 1 }, preferName: true }, maxCommits: 50, pickaxe: false });
    expect(h.mode).toBe('range');
    expect(h.fallbackReasons[0]).toMatch(/could not find a function named "nope"/);
    expect(h.history.entries.map((e) => e.authorName)).toEqual(['Dee']);
  });

  it('falls back to whole-file history with --follow when nothing else works', async () => {
    const h = await loadCodeHistory({ runner, target: { path: 'src/calc.js', name: 'nope', range: { start: 500, end: 501 } }, maxCommits: 50, pickaxe: false });
    expect(h.mode).toBe('file');
    expect(h.fallbackReasons).toHaveLength(2);
    expect(h.fallbackReasons[0]).toMatch(/could not follow lines 500–501/);
    expect(h.history.entries.map((e) => e.authorName)).toEqual(['Dee', 'Cid', 'Bob', 'Ann']);
    expect(h.history.entries[1]!.files[0]).toMatchObject({ status: 'renamed', oldPath: 'src/math.js', path: 'src/calc.js' });
    expect(h.history.entries[3]!.firstAdded).toBe(true);
  });

  it('finds commits on any branch that add or remove the name', async () => {
    const h = await loadCodeHistory({ runner, target: { path: 'src/calc.js', name: 'add', range: { start: 2, end: 5 } }, maxCommits: 50, pickaxe: true });
    expect(h.pickaxe?.term).toBe('add');
    expect(h.pickaxe!.entries.map((e) => e.authorName)).toEqual(['Eve', 'Ann']);
    expect(h.pickaxe!.entries.at(-1)).toMatchObject({ firstAdded: true });
    expect(h.pickaxe!.entries[0]!.files).toEqual([{ path: 'side.js', status: 'added' }]);
  });

  it('truncates long histories without claiming the first commit', async () => {
    const h = await loadCodeHistory({ runner, target: { path: 'src/calc.js' }, maxCommits: 2, pickaxe: true });
    expect(h.mode).toBe('file');
    expect(h.history.entries).toHaveLength(2);
    expect(h.history.truncated).toBe(true);
    expect(h.history.entries.some((e) => e.firstAdded)).toBe(false);
    expect(h.pickaxe).toBeUndefined();
  });

  it('rejects files that were never committed', async () => {
    repo.write('new.js', 'x\n');
    await expect(loadCodeHistory({ runner, target: { path: 'new.js', name: 'x' }, maxCommits: 5, pickaxe: false })).rejects.toBeInstanceOf(NotCommittedError);
  });

  it('detects working-tree changes against HEAD', async () => {
    expect(await isModifiedSinceHead(runner, 'src/calc.js')).toBe(false);
    repo.write('src/calc.js', `${v3}// edit\n`);
    expect(await isModifiedSinceHead(runner, 'src/calc.js')).toBe(true);
    repo.git('checkout', '--', 'src/calc.js');
  });

  it('passes through non-git errors', async () => {
    const broken = { run: async () => { throw new TypeError('boom'); } };
    await expect(loadCodeHistory({ runner: broken, target: { path: 'x' }, maxCommits: 5, pickaxe: false })).rejects.toThrow('boom');
    let calls = 0;
    const flaky = { run: async () => { if (calls++ === 0) return ''; throw new TypeError('later'); } };
    await expect(loadCodeHistory({ runner: flaky, target: { path: 'x', range: { start: 1, end: 2 } }, maxCommits: 5, pickaxe: false })).rejects.toThrow('later');
  });
});
