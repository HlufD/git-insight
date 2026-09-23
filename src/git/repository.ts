import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface RepoLocation {
  /** Working-tree root (the folder that contains `.git`). */
  root: string;
  /** Per-worktree git dir (holds HEAD). */
  gitDir: string;
  /** Shared git dir (holds refs, packed-refs, shallow). Same as gitDir outside linked worktrees. */
  commonDir: string;
}

/**
 * Finds the repository containing `folder` by walking up to the first `.git`
 * directory or `.git` file (worktrees, submodules). Does not run git.
 */
export async function findRepository(folder: string): Promise<RepoLocation | undefined> {
  let current = path.resolve(folder);
  for (;;) {
    const location = await readDotGit(current);
    if (location) return location;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readDotGit(root: string): Promise<RepoLocation | undefined> {
  const dotGit = path.join(root, '.git');
  const stat = await fs.stat(dotGit).catch(() => undefined);
  if (!stat) return undefined;
  if (stat.isDirectory()) return { root, gitDir: dotGit, commonDir: dotGit };

  const content = await fs.readFile(dotGit, 'utf8').catch(() => '');
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) return undefined;
  const gitDir = path.resolve(root, match[1]!);
  const commonDirFile = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
  const commonDir = commonDirFile ? path.resolve(gitDir, commonDirFile.trim()) : gitDir;
  return { root, gitDir, commonDir };
}

export async function isShallowRepository(repo: RepoLocation): Promise<boolean> {
  const stat = await fs.stat(path.join(repo.commonDir, 'shallow')).catch(() => undefined);
  return !!stat && stat.size > 0;
}

/**
 * A hash that changes whenever any ref, HEAD or `.mailmap` changes. Reads files
 * directly so a cache lookup needs no git process. Covers `--all`, not just HEAD.
 */
export async function refsFingerprint(repo: RepoLocation): Promise<string> {
  const hash = createHash('sha256');
  const add = (label: string, content: string | Buffer) => {
    hash.update(label).update('\0').update(content).update('\0');
  };

  add('HEAD', await readOrEmpty(path.join(repo.gitDir, 'HEAD')));
  add('packed-refs', await readOrEmpty(path.join(repo.commonDir, 'packed-refs')));
  add('shallow', await readOrEmpty(path.join(repo.commonDir, 'shallow')));
  add('mailmap', await readOrEmpty(path.join(repo.root, '.mailmap')));

  for (const file of await listFiles(path.join(repo.commonDir, 'refs'))) {
    add(path.relative(repo.commonDir, file), await readOrEmpty(file));
  }
  // reftable repositories store refs in binary tables; size + mtime is enough to detect changes.
  for (const file of await listFiles(path.join(repo.commonDir, 'reftable'))) {
    const stat = await fs.stat(file).catch(() => undefined);
    add(path.relative(repo.commonDir, file), stat ? `${stat.size}:${stat.mtimeMs}` : '');
  }
  return hash.digest('hex');
}

async function readOrEmpty(file: string): Promise<Buffer | string> {
  return fs.readFile(file).catch(() => '');
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
