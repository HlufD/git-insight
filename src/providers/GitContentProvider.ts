import * as vscode from 'vscode';
import { GIT_SCHEME } from '../constants';
import { findRepository } from '../git/repository';
import type { RepoService } from '../services/RepoService';

const CACHE_LIMIT = 50;

/**
 * Builds a URI for a file at a commit. An empty `ref` means "no file" (the
 * left side of a diff for an added file or a root commit).
 */
export function gitUri(repoRoot: string, ref: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${path}`,
    query: new URLSearchParams({ repo: repoRoot, ref }).toString(),
  });
}

/** Serves `gitinsight:` URIs with `git show <ref>:<path>`, byte for byte. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly repos: RepoService,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const root = params.get('repo');
    const ref = params.get('ref');
    const path = uri.path.replace(/^\//, '');
    if (!root || !ref || !path) return '';

    const key = uri.toString();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const repo = await findRepository(root);
    if (!repo) return '';
    try {
      // Contents at a commit never change, so they can be cached.
      const text = (await this.repos.runner(repo).runBuffer(['show', `${ref}:${path}`])).toString('utf8');
      this.cache.set(key, text);
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      return text;
    } catch (error) {
      this.log.warn(`Could not read ${path} at ${ref}: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }
}
