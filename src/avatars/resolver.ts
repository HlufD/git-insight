import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { circularImageSvg, emailKey, githubUserFromEmail, gravatarUrl, initialsSvg } from './identity';

/** What we know about a person's online identity. Persisted per email. */
export interface AvatarRecord {
  /** GitHub username, when known. */
  login?: string;
  /** Remote image URL (for hovers). */
  avatarUrl?: string;
  /** Local circular SVG of the downloaded image. */
  avatarFile?: string;
  source: 'github' | 'gravatar' | 'none';
  checkedAt: number;
  /** The GitHub API was asked about this person (so we know whether they have a username). */
  apiChecked?: boolean;
}

export interface AvatarStore {
  get(emailKey: string): AvatarRecord | undefined;
  set(emailKey: string, record: AvatarRecord): void | Thenable<void>;
}

export interface GitHubCommitRef {
  owner: string;
  repo: string;
  sha: string;
}

export interface AvatarResolverOptions {
  dir: string;
  store: AvatarStore;
  fetch: typeof fetch;
  /** Token for private repositories (e.g. the VS Code GitHub session); optional. */
  getToken?: () => Promise<string | undefined>;
  now?: () => number;
  timeoutMs?: number;
}

const SIZE = 64;
/** People without an avatar are checked again after a week. */
const RECHECK_MS = 7 * 24 * 3600 * 1000;
/** After a network failure, stay offline for a while instead of retrying every row. */
const OFFLINE_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Finds avatars and GitHub usernames. Order: username from a GitHub noreply
 * email (no network), then the GitHub API for a known commit, then GitHub or
 * Gravatar images. Every miss falls back to generated initials.
 */
export class AvatarResolver {
  private readonly inflight = new Map<string, Promise<AvatarRecord>>();
  private offlineUntil = 0;
  private apiBlockedUntil = 0;
  private readonly now: () => number;

  constructor(private readonly options: AvatarResolverOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Path of the initials avatar for a person, created on first use. */
  async initialsFile(name: string, email: string): Promise<string> {
    const key = `${emailKey(email || name)}-${emailKey(name).slice(0, 8)}`;
    const file = path.join(this.options.dir, `initials-${key}.svg`);
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(this.options.dir, { recursive: true });
      await fs.writeFile(file, initialsSvg(name, email || name), 'utf8');
    }
    return file;
  }

  /** The stored record, if it is still usable. Never touches the network. */
  cached(email: string): AvatarRecord | undefined {
    return this.options.store.get(emailKey(email));
  }

  /** Looks the person up online (once per email; concurrent calls share one lookup). */
  resolve(email: string, commit?: GitHubCommitRef): Promise<AvatarRecord> {
    const key = emailKey(email);
    const existing = this.options.store.get(key);
    if (existing) {
      // A commit can reveal a GitHub username that an email-only lookup could not.
      const couldLearnLogin = !!commit && !existing.login && !existing.apiChecked;
      const fresh = this.now() - existing.checkedAt < RECHECK_MS;
      if (!couldLearnLogin && (existing.avatarFile || fresh)) return Promise.resolve(existing);
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.lookup(email, key, commit).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async lookup(email: string, key: string, commit?: GitHubCommitRef): Promise<AvatarRecord> {
    const empty: AvatarRecord = { source: 'none', checkedAt: this.now() };
    if (this.now() < this.offlineUntil) return empty;

    try {
      const noreply = githubUserFromEmail(email);
      let login = noreply?.login;
      let apiAvatar: string | undefined;
      let apiChecked = false;

      if (!login && commit && this.now() >= this.apiBlockedUntil) {
        const author = await this.commitAuthor(commit);
        apiChecked = author.checked;
        login = author.login;
        apiAvatar = author.avatarUrl;
      }

      const candidates: { url: string; source: AvatarRecord['source'] }[] = [];
      if (apiAvatar) candidates.push({ url: withSize(apiAvatar), source: 'github' });
      else if (noreply?.id) candidates.push({ url: `https://avatars.githubusercontent.com/u/${noreply.id}?s=${SIZE}&v=4`, source: 'github' });
      else if (login) candidates.push({ url: `https://github.com/${encodeURIComponent(login)}.png?size=${SIZE}`, source: 'github' });
      candidates.push({ url: gravatarUrl(email, SIZE), source: 'gravatar' });

      for (const candidate of candidates) {
        const image = await this.download(candidate.url);
        if (!image) continue;
        await fs.mkdir(this.options.dir, { recursive: true });
        const avatarFile = path.join(this.options.dir, `avatar-${key}.svg`);
        await fs.writeFile(avatarFile, circularImageSvg(image.data, image.mime), 'utf8');
        const record: AvatarRecord = { login, avatarUrl: candidate.url, avatarFile, source: candidate.source, checkedAt: this.now(), apiChecked };
        await this.options.store.set(key, record);
        return record;
      }
      const record: AvatarRecord = { login, source: 'none', checkedAt: this.now(), apiChecked };
      await this.options.store.set(key, record);
      return record;
    } catch {
      // Offline or DNS failure: don't remember the miss, just back off.
      this.offlineUntil = this.now() + OFFLINE_BACKOFF_MS;
      return empty;
    }
  }

  private async commitAuthor(commit: GitHubCommitRef): Promise<{ checked: boolean; login?: string; avatarUrl?: string }> {
    const url = `https://api.github.com/repos/${encodeURIComponent(commit.owner)}/${encodeURIComponent(commit.repo)}/commits/${encodeURIComponent(commit.sha)}`;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'git-insight-vscode' };
    const token = await this.options.getToken?.().catch(() => undefined);
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.options.fetch(url, { headers, signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) });
    if (response.status === 403 || response.status === 429) {
      // Rate limited: stop asking the API for an hour, and try again for this person later.
      this.apiBlockedUntil = this.now() + 3600 * 1000;
      return { checked: false };
    }
    if (!response.ok) return { checked: true };
    const body = (await response.json()) as { author?: { login?: unknown; avatar_url?: unknown } | null };
    const login = typeof body.author?.login === 'string' ? body.author.login : undefined;
    const avatarUrl = login && typeof body.author?.avatar_url === 'string' ? body.author.avatar_url : undefined;
    return { checked: true, login, avatarUrl };
  }

  private async download(url: string): Promise<{ data: Buffer; mime: string } | undefined> {
    const response = await this.options.fetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) });
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !mime.startsWith('image/')) return undefined;
    const data = Buffer.from(await response.arrayBuffer());
    return data.length > 0 && data.length < 1_000_000 ? { data, mime } : undefined;
  }
}

function withSize(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}s=${SIZE}`;
}
