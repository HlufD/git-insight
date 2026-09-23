import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** A throwaway repository driven with real git commands (integration tests only). */
export class TempRepo {
  readonly root = mkdtempSync(path.join(tmpdir(), 'gi-repo-'));
  private tick = 0;

  constructor() {
    this.git('init', '-q', '-b', 'main');
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: this.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: this.root, GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'c@x' },
    });
  }

  write(file: string, content: string | Buffer): void {
    const full = path.join(this.root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  commit(author: string, files: Record<string, string | Buffer>, date?: string): void {
    for (const [file, content] of Object.entries(files)) this.write(file, content);
    this.git('add', '-A');
    const when = date ?? `2026-08-${String(1 + (this.tick++ % 28)).padStart(2, '0')}T10:00:00+03:00`;
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `change ${this.tick}`, `--author=${author}`, `--date=${when}`], {
      cwd: this.root,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: this.root, GIT_COMMITTER_NAME: 'Committer', GIT_COMMITTER_EMAIL: 'c@x', GIT_COMMITTER_DATE: when },
    });
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Builds a repo with `count` commits quickly through `git fast-import`. */
export function fastImportRepo(count: number, authors: number): TempRepo {
  const repo = new TempRepo();
  const chunks: string[] = [];
  const base = Date.parse('2020-01-01T00:00:00Z') / 1000;
  for (let i = 0; i < count; i++) {
    const a = i % authors;
    const content = `line ${i}\n`.repeat(1 + (i % 5));
    const ts = base + i * 3600;
    chunks.push(
      'commit refs/heads/main',
      `mark :${i + 1}`,
      `author Author ${a} <author${a}@example.com> ${ts} +0300`,
      `committer Author ${a} <author${a}@example.com> ${ts} +0300`,
      'data 7',
      `commit ${String(i % 10)}`.slice(0, 7),
      ...(i > 0 ? [`from :${i}`] : []),
      `M 100644 inline src/file${i % 200}.txt`,
      `data ${Buffer.byteLength(content)}`,
      content,
    );
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo.root, input: `${chunks.join('\n')}\n` });
  return repo;
}
