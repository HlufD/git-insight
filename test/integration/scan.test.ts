import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatsCache } from '../../src/cache/StatsCache';
import { EmptyRepositoryError, GitInsightError } from '../../src/git/errors';
import { GitRunner, type GitInvocation } from '../../src/git/GitRunner';
import { findRepository, isShallowRepository, refsFingerprint, type RepoLocation } from '../../src/git/repository';
import { emptyAliasFile } from '../../src/stats/aliasFile';
import { buildReport } from '../../src/stats/report';
import { loadRawStats, statsLogArgs } from '../../src/stats/scan';
import { fastImportRepo, TempRepo } from './gitRepo';

const EXCLUDE = ['**/package-lock.json'];

describe('contributor stats on a real repository', () => {
  let repo: TempRepo;
  let location: RepoLocation;
  let cacheDir: string;

  beforeAll(async () => {
    repo = new TempRepo();
    repo.commit('Bewuket Baye <bewuket@company.com>', { 'src/a.ts': 'a\nb\nc\n', 'package-lock.json': '{}\n' });
    repo.commit('bewuket <b@laptop.local>', { 'src/a.ts': 'a\nB\nc\nd\n' });
    repo.commit('bewuket0 <bewuket0@gmail.com>', { 'logo.png': Buffer.from([0, 1, 2, 0, 255]) });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.commit('Smith, John <john@x.com>', { 'src/b.ts': 'x\n' });
    repo.commit('Zoë Ünïcode <zoe@x.com>', { 'docs/ü.md': 'hi\n' });
    repo.git('checkout', '-q', 'main');
    repo.commit('Bewuket Baye <bewuket@company.com>', { 'src/c.ts': 'c\n' });
    repo.git('-c', 'user.name=Merger', '-c', 'user.email=m@x', 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    repo.git('checkout', '-q', '-b', 'side');
    repo.commit('dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>', { 'src/d.ts': 'd\n' });
    repo.git('checkout', '-q', 'main');
    location = (await findRepository(path.join(repo.root, 'src')))!;
    cacheDir = await mkdtemp(path.join(tmpdir(), 'gi-cache-'));
  });

  afterAll(async () => {
    repo.remove();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('finds the repository from a subfolder', () => {
    expect(location.root).toBe(repo.root);
  });

  it('matches git shortlog -sn --all --no-merges', async () => {
    const { stats } = await loadRawStats({ repo: location, runner: new GitRunner(repo.root), filter: {}, excludePaths: EXCLUDE });
    const ours = new Map<string, number>();
    for (const s of stats.identities) if (s.commits) ours.set(s.name, (ours.get(s.name) ?? 0) + s.commits);

    const shortlog = new Map<string, number>();
    for (const line of repo.git('shortlog', '-sn', '--all', '--no-merges', 'HEAD').trim().split('\n')) {
      const [, count, name] = /^\s*(\d+)\t(.+)$/.exec(line)!;
      shortlog.set(name!, Number(count));
    }
    expect(ours).toEqual(shortlog);
  });

  it('counts merges, lines and binary files', async () => {
    const { stats } = await loadRawStats({ repo: location, runner: new GitRunner(repo.root), filter: {}, excludePaths: EXCLUDE });
    const find = (name: string) => stats.identities.find((s) => s.name === name)!;
    expect(find('Merger')).toMatchObject({ commits: 0, merges: 1, added: 0 });
    expect(find('Bewuket Baye')).toMatchObject({ commits: 2, added: 4, removed: 0 }); // lockfile excluded
    expect(find('bewuket')).toMatchObject({ added: 2, removed: 1 });
    expect(find('bewuket0')).toMatchObject({ binaryFiles: 1, added: 0 });
    expect(find('Zoë Ünïcode').days).toEqual(['2026-08-05']);
  });

  it('suggests the bewuket identities as one group and hides the bot', async () => {
    const { stats } = await loadRawStats({ repo: location, runner: new GitRunner(repo.root), filter: {}, excludePaths: EXCLUDE });
    const report = buildReport(stats, emptyAliasFile(), { excludeBots: true, botPatterns: ['\\[bot\\]'] });
    expect(report.hiddenBots).toBe(1);
    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]!.members.map((m) => m.split(' <')[0]).sort()).toEqual(['Bewuket Baye', 'bewuket', 'bewuket0']);
  });

  it('loads a second run from cache with no git call, and rescans when refs change', async () => {
    const calls: GitInvocation[] = [];
    const runner = new GitRunner(repo.root, { onInvocation: (c) => calls.push(c) });
    const cache = new StatsCache(cacheDir);
    const first = await loadRawStats({ repo: location, runner, filter: {}, excludePaths: EXCLUDE, cache });
    expect(first.fromCache).toBe(false);
    expect(calls.length).toBeGreaterThan(0);

    calls.length = 0;
    const second = await loadRawStats({ repo: location, runner, filter: {}, excludePaths: EXCLUDE, cache: new StatsCache(cacheDir) });
    expect(second.fromCache).toBe(true);
    expect(calls).toEqual([]);
    expect(second.stats).toEqual(first.stats);

    const differentFilter = await loadRawStats({ repo: location, runner, filter: { since: '2026-08-03' }, excludePaths: EXCLUDE, cache });
    expect(differentFilter.fromCache).toBe(false);

    repo.git('branch', 'new-branch', 'side');
    const afterBranch = await loadRawStats({ repo: location, runner, filter: { since: '2026-08-03' }, excludePaths: EXCLUDE, cache });
    expect(afterBranch.fromCache).toBe(false);

    await cache.clear();
    expect(await cache.get(repo.root, 'anything')).toBeUndefined();
  });

  it('filters by ref and path', async () => {
    const runner = new GitRunner(repo.root);
    const onFeature = await loadRawStats({ repo: location, runner, filter: { ref: 'refs/heads/feature' }, excludePaths: [] });
    expect(onFeature.stats.identities.map((s) => s.name).sort()).toEqual(['Bewuket Baye', 'Smith, John', 'Zoë Ünïcode', 'bewuket', 'bewuket0']);
    const docsOnly = await loadRawStats({ repo: location, runner, filter: { paths: ['docs/**'] }, excludePaths: [] });
    expect(docsOnly.stats.identities.map((s) => s.name)).toEqual(['Zoë Ünïcode']);
  });

  it('reports progress', async () => {
    const seen: number[] = [];
    await loadRawStats({ repo: location, runner: new GitRunner(repo.root), filter: {}, excludePaths: [], onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(8);
  });

  it('rejects refs that are not full ref names', () => {
    expect(() => statsLogArgs({ ref: '--output=/tmp/x' })).toThrow(GitInsightError);
    expect(statsLogArgs({ ref: 'refs/tags/v1', paths: ['src/**'] })).toEqual(expect.arrayContaining(['refs/tags/v1', '--', ':(glob)src/**']));
  });
});

describe('repository edge cases', () => {
  it('reports an empty repository', async () => {
    const repo = new TempRepo();
    try {
      const location = (await findRepository(repo.root))!;
      await expect(loadRawStats({ repo: location, runner: new GitRunner(repo.root), filter: {}, excludePaths: [] })).rejects.toBeInstanceOf(EmptyRepositoryError);
    } finally {
      repo.remove();
    }
  });

  it('returns undefined outside any repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gi-norepo-'));
    try {
      // tmpdir itself is not inside a repo on CI machines; skip if it happens to be.
      const found = await findRepository(dir);
      if (found) expect(found.root).not.toBe(dir);
      else expect(found).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('follows .git files for linked worktrees and detects shallow clones', async () => {
    const repo = new TempRepo();
    repo.commit('A <a@x>', { 'a.txt': '1\n' });
    repo.commit('A <a@x>', { 'a.txt': '2\n' });
    const worktree = `${repo.root}-wt`;
    const shallow = `${repo.root}-shallow`;
    try {
      repo.git('worktree', 'add', '-q', '-b', 'wt', worktree);
      const location = (await findRepository(worktree))!;
      expect(location.root).toBe(worktree);
      expect(location.commonDir).toBe(path.join(repo.root, '.git'));
      expect(location.gitDir).not.toBe(location.commonDir);
      expect(await isShallowRepository(location)).toBe(false);

      execFileSync('git', ['clone', '-q', '--depth=1', `file://${repo.root}`, shallow]);
      expect(await isShallowRepository((await findRepository(shallow))!)).toBe(true);

      const brokenGitFile = await mkdtemp(path.join(tmpdir(), 'gi-bad-'));
      await writeFile(path.join(brokenGitFile, '.git'), 'nonsense');
      const result = await findRepository(brokenGitFile);
      expect(result?.root).not.toBe(brokenGitFile);
      await rm(brokenGitFile, { recursive: true, force: true });
    } finally {
      repo.remove();
      await rm(worktree, { recursive: true, force: true });
      await rm(shallow, { recursive: true, force: true });
    }
  });

  it('changes the fingerprint when .mailmap changes', async () => {
    const repo = new TempRepo();
    repo.commit('A <a@x>', { 'a.txt': '1\n' });
    try {
      const location = (await findRepository(repo.root))!;
      const before = await refsFingerprint(location);
      expect(await refsFingerprint(location)).toBe(before);
      repo.write('.mailmap', 'A <a@x> <old@x>\n');
      expect(await refsFingerprint(location)).not.toBe(before);
    } finally {
      repo.remove();
    }
  });
});

describe('performance', () => {
  it('scans 10k commits in under 10 s cold and under 1 s cached', async () => {
    const repo = fastImportRepo(10_000, 60);
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'gi-perf-'));
    try {
      const location = (await findRepository(repo.root))!;
      const runner = new GitRunner(repo.root);
      let started = performance.now();
      const cold = await loadRawStats({ repo: location, runner, filter: {}, excludePaths: [], cache: new StatsCache(cacheDir) });
      const coldMs = performance.now() - started;
      expect(cold.stats.commitCount).toBe(10_000);
      expect(cold.stats.identities).toHaveLength(60);

      started = performance.now();
      const warm = await loadRawStats({ repo: location, runner, filter: {}, excludePaths: [], cache: new StatsCache(cacheDir) });
      const warmMs = performance.now() - started;
      expect(warm.fromCache).toBe(true);

      console.log(`10k commits: cold ${coldMs.toFixed(0)} ms, cached ${warmMs.toFixed(0)} ms`);
      expect(coldMs).toBeLessThan(10_000);
      expect(warmMs).toBeLessThan(1_000);
    } finally {
      repo.remove();
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 60_000);
});
