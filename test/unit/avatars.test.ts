import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  avatarColor, circularImageSvg, emailKey, githubUserFromEmail, gravatarUrl, initials, initialsSvg, parseGitHubRemote,
} from '../../src/avatars/identity';
import { AvatarResolver, type AvatarRecord } from '../../src/avatars/resolver';

describe('identity helpers', () => {
  it.each([
    ['12345+octocat@users.noreply.github.com', { login: 'octocat', id: 12345 }],
    ['Octo-Cat@users.noreply.github.com', { login: 'Octo-Cat', id: undefined }],
    ['octocat@github.com', undefined],
    ['-bad@users.noreply.github.com', undefined],
  ])('githubUserFromEmail(%s)', (email, expected) => {
    expect(githubUserFromEmail(email)).toEqual(expected);
  });

  it.each([
    ['https://github.com/HlufD/git-insight.git', { owner: 'HlufD', repo: 'git-insight' }],
    ['https://token@github.com/HlufD/git-insight', { owner: 'HlufD', repo: 'git-insight' }],
    ['git@github.com:HlufD/git-insight.git', { owner: 'HlufD', repo: 'git-insight' }],
    ['ssh://git@github.com:22/a/b.c/', { owner: 'a', repo: 'b.c' }],
    ['https://gitlab.com/a/b.git', undefined],
    ['git@github.com:only-owner', undefined],
  ])('parseGitHubRemote(%s)', (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected);
  });

  it.each([
    ['Bewuket Baye', 'BB'], ['bewuket0', 'B'], ['Smith, John', 'SJ'], ['zoë ünïcode', 'ZÜ'], ['12345', '?'], ['', '?'], ['Mary-Jane O’Neil', 'MO'],
  ])('initials(%s) → %s', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  it('gives each person a stable colour', () => {
    expect(avatarColor('A@x.com')).toBe(avatarColor('a@x.com'));
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(avatarColor)).size).toBeGreaterThan(3);
  });

  it('builds escaped initials and circular image SVGs', () => {
    expect(initialsSvg('<x> & y', 'k')).toContain('>XY</text>');
    expect(initialsSvg('Ann', 'k')).toContain('font-size="15"');
    expect(circularImageSvg(Buffer.from('png'), 'image/png')).toContain('href="data:image/png;base64,cG5n"');
  });

  it('hashes emails case-insensitively', () => {
    expect(gravatarUrl(' A@X.com ', 64)).toBe(gravatarUrl('a@x.com', 64));
    expect(gravatarUrl('a@x.com', 64)).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?s=64&d=404$/);
    expect(emailKey('A@x.com')).toBe(emailKey('a@x.com'));
  });
});

type Route = { status?: number; type?: string; body?: unknown };

function fakeFetch(routes: Record<string, Route | (() => never)>) {
  const calls: { url: string; auth?: string }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const route = key ? routes[key]! : { status: 404 };
    if (typeof route === 'function') route();
    const r = route as Route;
    const body = typeof r.body === 'object' && !Buffer.isBuffer(r.body) ? JSON.stringify(r.body) : (r.body as string | Buffer | undefined) ?? '';
    return new Response(Buffer.isBuffer(body) ? new Uint8Array(body) : body, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('AvatarResolver', () => {
  let dir: string;
  let store: Map<string, AvatarRecord>;
  let clock: number;
  const png = { status: 200, type: 'image/png', body: Buffer.from([137, 80, 78, 71]) };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gi-avatar-'));
    store = new Map();
    clock = 1_000_000;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const resolver = (routes: Parameters<typeof fakeFetch>[0], token?: string) => {
    const f = fakeFetch(routes);
    const r = new AvatarResolver({ dir, store: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) }, fetch: f.fn, getToken: async () => token, now: () => clock });
    return { r, calls: f.calls };
  };
  const commit = { owner: 'o', repo: 'r', sha: 'abc' };

  it('writes an initials avatar once', async () => {
    const { r } = resolver({});
    const file = await r.initialsFile('Ann Lee', 'ann@x.com');
    expect(await readFile(file, 'utf8')).toContain('>AL</text>');
    expect(await r.initialsFile('Ann Lee', 'ann@x.com')).toBe(file);
  });

  it('uses the GitHub noreply id without calling the API', async () => {
    const { r, calls } = resolver({ 'https://avatars.githubusercontent.com/u/42': png });
    const rec = await r.resolve('42+octo@users.noreply.github.com', commit);
    expect(rec).toMatchObject({ login: 'octo', source: 'github' });
    expect(calls.map((c) => c.url)).toEqual(['https://avatars.githubusercontent.com/u/42?s=64&v=4']);
    expect(await readFile(rec.avatarFile!, 'utf8')).toContain('data:image/png;base64,');
  });

  it('asks the GitHub API for a commit author, sending the token', async () => {
    const { r, calls } = resolver({
      'https://api.github.com/repos/o/r/commits/abc': { body: { author: { login: 'ann', avatar_url: 'https://avatars.example/u/1?v=4' } } },
      'https://avatars.example/u/1': png,
    }, 'tok');
    const rec = await r.resolve('ann@corp.com', commit);
    expect(rec).toMatchObject({ login: 'ann', source: 'github', apiChecked: true, avatarUrl: 'https://avatars.example/u/1?v=4&s=64' });
    expect(calls[0]!.auth).toBe('Bearer tok');
    // Stored: a second call makes no requests.
    calls.length = 0;
    expect(await r.resolve('ann@corp.com', commit)).toEqual(rec);
    expect(calls).toEqual([]);
  });

  it('falls back to github.com/<login>.png, then Gravatar, then nothing', async () => {
    const login = resolver({ 'https://github.com/octo.png': png });
    expect(await login.r.resolve('octo@users.noreply.github.com')).toMatchObject({ login: 'octo', source: 'github' });

    const grav = resolver({ 'https://www.gravatar.com/': { status: 200, type: 'image/jpeg', body: 'jpg' } });
    expect(await grav.r.resolve('someone@x.com')).toMatchObject({ source: 'gravatar', login: undefined });

    const none = resolver({ 'https://www.gravatar.com/': { status: 200, type: 'text/html', body: '<html>' } });
    const rec = await none.r.resolve('nobody@x.com');
    expect(rec).toMatchObject({ source: 'none' });
    expect(rec.avatarFile).toBeUndefined();
  });

  it('remembers misses for a week, but still asks the API once a commit is known', async () => {
    const { r, calls } = resolver({ 'https://api.github.com/': { body: { author: null } } });
    await r.resolve('x@x.com');
    expect(calls).toHaveLength(1); // gravatar
    await r.resolve('x@x.com');
    expect(calls).toHaveLength(1);
    await r.resolve('x@x.com', commit);
    expect(calls.map((c) => c.url)).toContain('https://api.github.com/repos/o/r/commits/abc');
    const count = calls.length;
    await r.resolve('x@x.com', commit);
    expect(calls).toHaveLength(count); // apiChecked
    clock += 8 * 24 * 3600 * 1000;
    await r.resolve('x@x.com');
    expect(calls.length).toBeGreaterThan(count);
  });

  it('backs off from the API when rate limited', async () => {
    const { r, calls } = resolver({ 'https://api.github.com/': { status: 403 } });
    expect(await r.resolve('a@x.com', commit)).toMatchObject({ apiChecked: false });
    await r.resolve('b@x.com', commit);
    expect(calls.filter((c) => c.url.startsWith('https://api.github.com/'))).toHaveLength(1);
  });

  it('treats network failures as offline, without storing a miss', async () => {
    const { r, calls } = resolver({ 'https://www.gravatar.com/': () => { throw new TypeError('fetch failed'); } });
    expect(await r.resolve('a@x.com')).toEqual({ source: 'none', checkedAt: clock });
    expect(store.size).toBe(0);
    await r.resolve('b@x.com');
    expect(calls).toHaveLength(1); // backing off
    clock += 11 * 60 * 1000;
    await r.resolve('b@x.com');
    expect(calls).toHaveLength(2);
  });

  it('shares one lookup between concurrent callers and ignores API errors', async () => {
    const { r, calls } = resolver({ 'https://api.github.com/': { status: 500 }, 'https://www.gravatar.com/': png });
    const [a, b] = await Promise.all([r.resolve('c@x.com', commit), r.resolve('c@x.com', commit)]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ apiChecked: true, source: 'gravatar' });
    expect(calls).toHaveLength(2);
    expect(r.cached('C@x.com')).toEqual(a);
  });

  it('rejects oversized images', async () => {
    const { r } = resolver({ 'https://www.gravatar.com/': { status: 200, type: 'image/png', body: Buffer.alloc(1_000_001) } });
    expect(await r.resolve('big@x.com')).toMatchObject({ source: 'none' });
  });
});
