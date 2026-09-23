import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { RAW_STATS_SCHEMA, type RawStats } from '../stats/types';

interface CacheEntry {
  key: string;
  stats: RawStats;
}

/**
 * Keeps the latest scan per repository as a JSON file in the extension's
 * storage folder. Files, not workspaceState, because results can be megabytes.
 */
export class StatsCache {
  private readonly memory = new Map<string, CacheEntry>();

  constructor(private readonly dir: string) {}

  async get(repoRoot: string, key: string): Promise<RawStats | undefined> {
    const hit = this.memory.get(repoRoot);
    if (hit?.key === key) return hit.stats;
    try {
      const entry = JSON.parse(await fs.readFile(this.fileFor(repoRoot), 'utf8')) as CacheEntry;
      if (entry.key !== key || entry.stats?.schema !== RAW_STATS_SCHEMA) return undefined;
      this.memory.set(repoRoot, entry);
      return entry.stats;
    } catch {
      return undefined;
    }
  }

  async set(repoRoot: string, key: string, stats: RawStats): Promise<void> {
    const entry = { key, stats };
    this.memory.set(repoRoot, entry);
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileFor(repoRoot);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(entry), 'utf8');
    await fs.rename(temp, file);
  }

  async clear(): Promise<void> {
    this.memory.clear();
    const files = await fs.readdir(this.dir).catch(() => []);
    await Promise.all(
      files.filter((f) => f.startsWith('stats-') && f.endsWith('.json')).map((f) => fs.rm(path.join(this.dir, f), { force: true })),
    );
  }

  private fileFor(repoRoot: string): string {
    return path.join(this.dir, `stats-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)}.json`);
  }
}
