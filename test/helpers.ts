import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** Loads a fixture, turning the visible ␞ / ␟ markers into the real \x1e / \x1f separators. */
export function fixture(name: string): string {
  return readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').replace(/␞/g, '\x1e').replace(/␟/g, '\x1f');
}

export const sha = (n: number) => n.toString(16).padStart(40, '0');
