import { chmodSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitCancelledError, GitCommandError, GitNotFoundError, NotARepositoryError } from '../../src/git/errors';
import { GitRunner, type GitInvocation } from '../../src/git/GitRunner';
import { TempRepo } from './gitRepo';

describe('GitRunner', () => {
  let repo: TempRepo;
  beforeAll(() => {
    repo = new TempRepo();
    repo.commit('A <a@x>', { 'a.txt': 'hello\n' });
  });
  afterAll(() => repo.remove());

  it('runs git with an argument array and reports invocations', async () => {
    const calls: GitInvocation[] = [];
    const runner = new GitRunner(repo.root, { onInvocation: (c) => calls.push(c) });
    // A value that would be dangerous in a shell is just an argument here.
    const out = await runner.run(['log', '--format=%an;$(echo pwned)', '-1']);
    expect(out).toBe('A;$(echo pwned)');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ exitCode: 0 });
  });

  it('streams lines', async () => {
    const lines: string[] = [];
    await new GitRunner(repo.root).streamLines(['ls-files'], (l) => lines.push(l));
    expect(lines).toEqual(['a.txt']);
  });

  it('maps failures to typed errors', async () => {
    await expect(new GitRunner(repo.root).run(['no-such-command'])).rejects.toBeInstanceOf(GitCommandError);
    await expect(new GitRunner(repo.root, { gitPath: '/nonexistent/git' }).run(['--version'])).rejects.toBeInstanceOf(GitNotFoundError);
    await expect(new GitRunner(path.dirname(repo.root)).run(['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(NotARepositoryError);
  });

  it('propagates errors thrown by the line callback', async () => {
    const boom = new Error('boom');
    await expect(new GitRunner(repo.root).streamLines(['ls-files'], () => { throw boom; })).rejects.toBe(boom);
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new GitRunner(repo.root).run(['status'], { signal: controller.signal })).rejects.toBeInstanceOf(GitCancelledError);
  });

  it.skipIf(process.platform === 'win32')('kills the process within 1 s of cancelling', async () => {
    const fake = path.join(repo.root, 'endless-git.sh');
    writeFileSync(fake, '#!/bin/sh\nwhile true; do echo line; sleep 0.01; done\n');
    chmodSync(fake, 0o755);
    const controller = new AbortController();
    let lines = 0;
    const runner = new GitRunner(repo.root, { gitPath: fake, globalArgs: [] });
    const pending = runner.streamLines(['log'], () => {
      if (++lines === 5) controller.abort();
    }, { signal: controller.signal });
    const started = Date.now();
    await expect(pending).rejects.toBeInstanceOf(GitCancelledError);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('GitRunner.runBuffer', () => {
  let repo: TempRepo;
  beforeAll(() => {
    repo = new TempRepo();
    repo.commit('A <a@x>', { 'crlf.txt': 'one\r\ntwo\r\n', 'bin.dat': Buffer.from([0, 255, 10, 13]) });
  });
  afterAll(() => repo.remove());

  it('returns file contents byte for byte', async () => {
    const runner = new GitRunner(repo.root);
    expect((await runner.runBuffer(['show', 'HEAD:crlf.txt'])).toString('utf8')).toBe('one\r\ntwo\r\n');
    expect([...(await runner.runBuffer(['show', 'HEAD:bin.dat']))]).toEqual([0, 255, 10, 13]);
  });

  it('refuses output above the size limit', async () => {
    await expect(new GitRunner(repo.root).runBuffer(['show', 'HEAD:crlf.txt'], { maxBytes: 4 })).rejects.toThrow(/larger than/);
  });

  it('reports each invocation once', async () => {
    const calls: GitInvocation[] = [];
    await new GitRunner(repo.root, { onInvocation: (c) => calls.push(c) }).runBuffer(['show', 'HEAD:crlf.txt']);
    expect(calls).toHaveLength(1);
  });
});
