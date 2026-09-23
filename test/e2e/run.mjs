// Launches VS Code with the extension under development and runs suite.cjs in it.
// Usage: node test/e2e/run.mjs <workspace-folder> [code-executable]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [workspace, code = 'code'] = process.argv.slice(2);
if (!workspace) throw new Error('usage: node test/e2e/run.mjs <workspace-folder> [code]');

const profile = mkdtempSync(path.join(tmpdir(), 'gi-e2e-'));
const results = path.join(profile, 'results.txt');
const run = spawnSync(code, [
  workspace,
  '--new-window', '--wait', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  `--user-data-dir=${path.join(profile, 'user')}`,
  `--extensions-dir=${path.join(profile, 'ext')}`,
  `--extensionDevelopmentPath=${path.resolve(here, '../..')}`,
  `--extensionTestsPath=${path.join(here, 'suite.cjs')}`,
], { stdio: 'inherit', env: { ...process.env, GI_E2E_RESULTS: results }, timeout: 180_000 });

let output = '';
try {
  output = readFileSync(results, 'utf8');
} catch {
  output = `No results written (exit ${run.status}, ${run.error ?? ''})\n`;
}
rmSync(profile, { recursive: true, force: true });
process.stdout.write(output);
process.exit(output.includes('FAIL') || !output.includes('PASS') ? 1 : 0);
