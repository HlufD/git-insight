// Runs inside a real VS Code extension host (see run.mjs). Plain CommonJS on purpose.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  const results = [];
  const step = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS ${name}`);
    } catch (error) {
      results.push(`FAIL ${name}: ${error && error.stack ? error.stack : error}`);
    }
  };

  const ext = vscode.extensions.getExtension('hluf.git-insight');
  const api = await ext.activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;

  await step('discovers the workspace repository', async () => {
    for (let i = 0; i < 50 && !api.stats.state.repo; i++) await sleep(100);
    assert.equal(api.stats.state.repo.root, root);
  });

  await step('registers every contributed command', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    for (const c of ext.packageJSON.contributes.commands) assert.ok(all.has(c.command), c.command);
  });

  await step('scans stats, hides the bot, suggests the bewuket group', async () => {
    await api.stats.refresh();
    const r = api.stats.state.report;
    assert.ok(r, `no report: ${api.stats.state.error}`);
    assert.equal(r.contributors.length, 7);
    assert.equal(r.hiddenBots, 1);
    assert.equal(r.suggestions.length, 1);
    assert.equal(r.suggestions[0].members.length, 3);
  });

  await step('accepting the suggestion merges it and writes aliases.json', async () => {
    const s = api.stats.state.report.suggestions[0];
    await api.stats.updateAliases((f) => ({ ...f, groups: [...f.groups, { name: s.suggestedName, email: s.suggestedEmail, members: s.members }] }));
    const r = api.stats.state.report;
    assert.equal(r.contributors.length, 5);
    assert.equal(r.contributors[0].name, 'Bewuket Baye');
    assert.equal(r.contributors[0].commits + r.contributors[0].merges, 28);
    assert.equal(r.suggestions.length, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.gitinsight', 'aliases.json'), 'utf8'));
    assert.equal(saved.groups.length, 1);
  });

  await step('second load comes from cache', async () => {
    await api.stats.clearCache();
    await api.stats.refresh();
    assert.equal(api.stats.state.fromCache, false);
    await api.stats.setFilter({});
    assert.equal(api.stats.state.fromCache, true);
  });

  await step('date filter rescans with fewer commits', async () => {
    await api.stats.setFilter({ since: '2026-08-01' });
    assert.equal(api.stats.state.fromCache, false);
    assert.equal(api.stats.state.raw.commitCount, 31);
    await api.stats.setFilter({});
  });

  await step('stats webview opens', async () => {
    await vscode.commands.executeCommand('gitInsight.showContributorStats');
    let labels = [];
    for (let i = 0; i < 50; i++) {
      labels = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
      if (labels.includes('Contributors: demo-repo')) break;
      await sleep(100);
    }
    assert.ok(labels.includes('Contributors: demo-repo'), `tabs: ${labels.join(', ')}`);
  });

  await step('ref change marks the view stale', async () => {
    const { execFileSync } = require('node:child_process');
    execFileSync('git', ['branch', 'e2e-new-branch'], { cwd: root });
    for (let i = 0; i < 50 && !api.stats.state.stale; i++) await sleep(100);
    assert.equal(api.stats.state.stale, true);
  });

  fs.writeFileSync(process.env.GI_E2E_RESULTS, results.join('\n') + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error(results.join('\n'));
};
