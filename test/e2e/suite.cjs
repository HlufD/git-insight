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

  // ── Feature 2: who wrote this ─────────────────────────────────────────────
  const { execFileSync } = require('node:child_process');
  const commitAs = (author, date, file, content, message) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
    execFileSync('git', ['add', file], { cwd: root });
    execFileSync('git', ['-c', 'user.name=C', '-c', 'user.email=c@x', 'commit', '-q', '-m', message, `--author=${author}`, `--date=${date}`], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: date } });
  };
  const v1 = 'export function price(qty: number) {\n  return qty * 2;\n}\n\nexport function tax(amount: number) {\n  return amount * 0.15;\n}\n';
  const v2 = v1.replace('return qty * 2;', 'const unit = 3;\n  return qty * unit;');
  commitAs('Ann <ann@x.com>', '2026-09-01T10:00:00+03:00', 'src/pricing.ts', v1, 'Add pricing');
  commitAs('Bob <bob@x.com>', '2026-09-02T10:00:00+03:00', 'src/pricing.ts', v2, 'Change unit price');

  let editor;
  await step('language server reports symbols for the file', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src/pricing.ts'));
    editor = await vscode.window.showTextDocument(doc);
    let symbols = [];
    for (let i = 0; i < 100 && !symbols?.length; i++) {
      symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
      if (!symbols?.length) await sleep(200);
    }
    assert.ok(symbols?.length, 'no symbols from TypeScript');
  });

  await step('who wrote price(): range history with first-added commit and pickaxe', async () => {
    editor.selection = new vscode.Selection(2, 4, 2, 4); // inside price()
    await api.history.whoWroteThis(editor);
    const { status, result, request, error } = api.history.state;
    assert.equal(status, 'ready', error);
    assert.equal(request.target.label, 'price()');
    assert.equal(result.mode, 'range');
    assert.deepEqual(result.history.entries.map((e) => e.authorName), ['Bob', 'Ann']);
    assert.equal(result.history.entries[1].firstAdded, true);
    assert.deepEqual(result.pickaxe.entries.map((e) => e.subject), ['Add pricing']);
  });

  await step('clicking a commit opens a diff with the committed contents', async () => {
    const entry = api.history.state.result.history.entries[0];
    await vscode.commands.executeCommand('gitInsight.openCommitDiff', {
      repoRoot: root, sha: entry.sha, parent: entry.parents[0], subject: entry.subject, file: entry.files[0], line: entry.line,
    });
    let tab;
    for (let i = 0; i < 50 && !tab; i++) {
      tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!(tab && tab.input instanceof vscode.TabInputTextDiff)) { tab = undefined; await sleep(100); }
    }
    assert.ok(tab, 'no diff tab');
    assert.equal(tab.input.modified.scheme, 'gitinsight');
    const right = await vscode.workspace.openTextDocument(tab.input.modified);
    const left = await vscode.workspace.openTextDocument(tab.input.original);
    assert.equal(right.getText(), v2);
    assert.equal(left.getText(), v1);
  });

  await step('added files diff against an empty left side', async () => {
    const first = api.history.state.result.history.entries[1];
    await vscode.commands.executeCommand('gitInsight.openCommitDiff', { repoRoot: root, sha: first.sha, parent: first.parents[0], subject: first.subject, file: first.files[0] });
    await sleep(300);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab.input instanceof vscode.TabInputTextDiff);
    assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), '');
    assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), v1);
  });

  await step('unsaved edits switch to function-name lookup', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src/pricing.ts'));
    editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// draft\n// more\n'));
    editor.selection = new vscode.Selection(8, 4, 8, 4); // inside tax(), shifted by 2 lines
    await api.history.whoWroteThis(editor);
    const { result, request } = api.history.state;
    assert.equal(request.modified, true);
    assert.equal(request.target.label, 'tax()');
    assert.equal(result.mode, 'function');
    assert.deepEqual(result.history.entries.map((e) => e.authorName), ['Ann']);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  await step('files without commits get a clear message', async () => {
    fs.writeFileSync(path.join(root, 'src/fresh.ts'), 'export const x = 1;\n');
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src/fresh.ts'));
    await api.history.whoWroteThis(await vscode.window.showTextDocument(doc));
    assert.equal(api.history.state.status, 'error');
    assert.match(api.history.state.error, /not been committed/);
  });

  await step('history rows show avatars, and the hover shows name and @username', async () => {
    const v3 = v2.replace('const unit = 3;', 'const unit = 4;');
    commitAs('Octo Cat <583231+octocat@users.noreply.github.com>', '2026-09-03T10:00:00+03:00', 'src/pricing.ts', v3, 'Raise unit price');
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src/pricing.ts'));
    const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(2, 4, 2, 4);
    await api.history.whoWroteThis(ed);
    const tree = api.trees.codeHistory;
    const sections = await tree.getChildren();
    const section = sections.find((n) => n.collapsibleState === vscode.TreeItemCollapsibleState.Expanded);
    const rows = await tree.getChildren(section);
    assert.equal(rows[0].label, 'Raise unit price');
    assert.ok(rows[0].iconPath instanceof vscode.Uri && rows[0].iconPath.fsPath.endsWith('.svg'), 'avatar icon');
    const tip = rows[0].tooltip.value;
    assert.match(tip, /\*\*Octo Cat\*\*/);
    assert.match(tip, /\[@octocat\]\(https:\/\/github\.com\/octocat\)/);
    assert.ok(tip.replace(/\\/g, '').includes('583231+octocat@users.noreply.github.com'), 'email in hover');
    assert.match(rows.at(-1).description, /★/);
    assert.ok(fs.readFileSync(rows[1].iconPath.fsPath, 'utf8').includes('<svg'), 'initials svg exists');
  });

  await step('contributor rows show avatars', async () => {
    await api.stats.refresh();
    const rows = await api.trees.contributors.getChildren();
    const person = rows.find((r) => r.contextValue === 'gitInsight.contributor');
    assert.ok(person.iconPath instanceof vscode.Uri && person.iconPath.fsPath.endsWith('.svg'));
    assert.match(person.tooltip.value, /Commits/);
  });

  fs.writeFileSync(process.env.GI_E2E_RESULTS, results.join('\n') + '\n');
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error(results.join('\n'));
};
