import * as path from 'node:path';
import * as vscode from 'vscode';
import { githubUserFromEmail, parseGitHubRemote } from '../avatars/identity';
import { AvatarResolver, type AvatarRecord } from '../avatars/resolver';
import type { RepoLocation } from '../git/repository';
import type { RepoService } from './RepoService';

export interface PersonAvatar {
  /** Local image for tree rows: the downloaded avatar or generated initials. */
  icon: vscode.Uri;
  /** GitHub username, when known. */
  login?: string;
  /** Remote image for hovers (https), when there is one. */
  imageUrl?: string;
  profileUrl?: string;
}

const STORE_KEY = 'gitInsight.avatars';

/**
 * Avatars and GitHub usernames for commit authors. With
 * `gitInsight.avatars.source = "initials"` nothing ever leaves the machine.
 */
export class AvatarService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly resolver: AvatarResolver;
  private readonly remotes = new Map<string, Promise<{ owner: string; repo: string } | undefined>>();
  private readonly dir: string;
  private notifyTimer: NodeJS.Timeout | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly globalState: vscode.Memento,
    storageDir: string,
    private readonly repos: RepoService,
  ) {
    this.dir = path.join(storageDir, 'avatars');
    this.resolver = new AvatarResolver({
      dir: this.dir,
      fetch: (...args) => fetch(...args),
      store: {
        get: (key) => this.records()[key],
        set: (key, record) => this.globalState.update(STORE_KEY, { ...this.records(), [key]: record }),
      },
      getToken: async () => (await vscode.authentication.getSession('github', ['repo'], { silent: true }))?.accessToken,
    });
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitInsight.avatars')) this.changed.fire();
    });
  }

  /**
   * The best avatar available right now. When online lookups are enabled, a
   * better one is fetched in the background and `onDidChange` fires once it arrives.
   */
  async get(name: string, email: string, commit?: { repo: RepoLocation; sha: string }): Promise<PersonAvatar> {
    const remote = this.remoteEnabled();
    const record = remote ? this.resolver.cached(email) : undefined;
    const avatar = this.toAvatar(record, email, await this.resolver.initialsFile(name, email));
    if (remote && email) void this.refine(email, commit, record);
    return avatar;
  }

  /** `https://github.com/<owner>/<repo>/commit/<sha>` when the repository's origin is on GitHub. */
  async commitUrl(repo: RepoLocation, sha: string): Promise<string | undefined> {
    const gh = await this.githubRemote(repo);
    return gh ? `https://github.com/${gh.owner}/${gh.repo}/commit/${sha}` : undefined;
  }

  async clear(): Promise<void> {
    await this.globalState.update(STORE_KEY, undefined);
    await vscode.workspace.fs.delete(vscode.Uri.file(this.dir), { recursive: true, useTrash: false }).then(undefined, () => undefined);
    this.changed.fire();
  }

  private async refine(email: string, commit: { repo: RepoLocation; sha: string } | undefined, before: AvatarRecord | undefined): Promise<void> {
    try {
      const gh = commit ? await this.githubRemote(commit.repo) : undefined;
      const after = await this.resolver.resolve(email, gh && commit ? { ...gh, sha: commit.sha } : undefined);
      if (after.avatarFile !== before?.avatarFile || after.login !== before?.login) this.notify();
    } catch {
      // Avatars are decoration; initials stay.
    }
  }

  private toAvatar(record: AvatarRecord | undefined, email: string, initials: string): PersonAvatar {
    const login = record?.login ?? githubUserFromEmail(email)?.login;
    return {
      icon: vscode.Uri.file(record?.avatarFile ?? initials),
      login,
      imageUrl: record?.avatarUrl,
      profileUrl: login ? `https://github.com/${encodeURIComponent(login)}` : undefined,
    };
  }

  private githubRemote(repo: RepoLocation): Promise<{ owner: string; repo: string } | undefined> {
    let pending = this.remotes.get(repo.root);
    if (!pending) {
      pending = this.repos
        .runner(repo)
        .run(['config', '--get', 'remote.origin.url'])
        .then((url) => parseGitHubRemote(url), () => undefined);
      this.remotes.set(repo.root, pending);
    }
    return pending;
  }

  private remoteEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitInsight').get<string>('avatars.source', 'remote') === 'remote';
  }

  private records(): Record<string, AvatarRecord> {
    return this.globalState.get<Record<string, AvatarRecord>>(STORE_KEY) ?? {};
  }

  /** Batches refreshes while many avatars arrive at once. */
  private notify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.changed.fire();
    }, 300);
  }

  dispose(): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.subscription.dispose();
    this.changed.dispose();
  }
}
