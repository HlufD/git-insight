import * as vscode from 'vscode';
import { acceptGroup, dissolveGroup, rejectMembers, removeFromGroup, renameGroup } from '../stats/aliasFile';
import type { AliasReason, AliasSuggestion, AmbiguousName } from '../stats/aliasSuggest';
import { parseIdentityId } from '../stats/identity';
import type { StatsService } from '../services/StatsService';

const REASONS: Record<AliasReason, string> = {
  'same-email': 'same email',
  'same-email-local-part': 'same email name',
  'similar-name': 'similar name',
  'name-subset': 'name contained in another',
};

type Entry =
  | (vscode.QuickPickItem & { kind: vscode.QuickPickItemKind.Separator })
  | (vscode.QuickPickItem & { suggestion: AliasSuggestion })
  | (vscode.QuickPickItem & { group: number })
  | (vscode.QuickPickItem & { ambiguous: AmbiguousName });

/**
 * CS-4: review alias suggestions and confirmed groups. Nothing is merged
 * without the user choosing it; every decision is saved to aliases.json.
 */
export async function reviewAliases(stats: StatsService): Promise<void> {
  for (;;) {
    const report = await stats.ensureReport();
    if (!report) return;
    const { aliases } = stats.state;
    const commitsOf = new Map(stats.state.raw?.identities.map((i) => [i.id, i.commits + i.merges]) ?? []);

    const entries: Entry[] = [];
    if (report.suggestions.length) {
      entries.push({ label: `Suggestions (${report.suggestions.length})`, kind: vscode.QuickPickItemKind.Separator });
      for (const s of report.suggestions) {
        entries.push({
          label: `$(person-add) ${s.suggestedName}`,
          description: `${s.members.length} identities · ${s.reasons.map((r) => REASONS[r]).join(', ')}${s.extendsGroups.length ? ' · extends a group' : ''}`,
          detail: s.members.map((m) => describeIdentity(m, commitsOf)).join('  ·  '),
          suggestion: s,
        });
      }
    }
    if (report.ambiguous.length) {
      entries.push({ label: 'Could be several people', kind: vscode.QuickPickItemKind.Separator });
      for (const a of report.ambiguous) {
        entries.push({
          label: `$(question) ${parseIdentityId(a.identity).name}`,
          description: `matches ${a.candidates.length} different names`,
          detail: a.candidates.map((c) => parseIdentityId(c).name).join('  ·  '),
          ambiguous: a,
        });
      }
    }
    if (aliases.groups.length) {
      entries.push({ label: `Confirmed groups (${aliases.groups.length})`, kind: vscode.QuickPickItemKind.Separator });
      aliases.groups.forEach((g, i) => {
        entries.push({
          label: `$(organization) ${g.name}`,
          description: `<${g.email}> · ${g.members.length} identities`,
          detail: g.members.map((m) => describeIdentity(m, commitsOf)).join('  ·  '),
          group: i,
        });
      });
    }
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('No alias suggestions: every identity looks like a different person.');
      return;
    }

    const picked = await vscode.window.showQuickPick(entries, {
      title: 'Git Insight: Contributor Aliases',
      placeHolder: 'Pick a suggestion to accept, split, rename or reject it',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if ('suggestion' in picked) await handleSuggestion(stats, picked.suggestion);
    else if ('ambiguous' in picked) await handleAmbiguous(stats, picked.ambiguous);
    else if ('group' in picked) await handleGroup(stats, picked.group);
  }
}

async function handleSuggestion(stats: StatsService, s: AliasSuggestion): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { id: 'accept', label: `$(check) Accept as ${s.suggestedName} <${s.suggestedEmail}>` },
      { id: 'rename', label: '$(edit) Accept with a different name or email…' },
      { id: 'split', label: '$(list-selection) Choose which identities belong together…' },
      { id: 'reject', label: '$(close) Reject: these are different people', description: 'never suggested again' },
    ],
    { title: s.members.map((m) => parseIdentityId(m).name).join(', ') },
  );
  switch (action?.id) {
    case 'accept':
      return stats.updateAliases((f) => acceptGroup(f, s.members, s.suggestedName, s.suggestedEmail));
    case 'rename': {
      const identity = await askIdentity(s.suggestedName, s.suggestedEmail, s.members);
      if (identity) await stats.updateAliases((f) => acceptGroup(f, s.members, identity.name, identity.email));
      return;
    }
    case 'split': {
      const chosen = await vscode.window.showQuickPick(
        s.members.map((m) => ({ label: m, picked: true })),
        { canPickMany: true, title: 'Tick the identities that are the same person' },
      );
      if (!chosen) return;
      const keep = chosen.map((c) => c.label);
      const leave = s.members.filter((m) => !keep.includes(m));
      if (keep.length < 2) {
        return stats.updateAliases((f) => rejectMembers(f, s.members));
      }
      const identity = await askIdentity(s.suggestedName, s.suggestedEmail, keep);
      if (!identity) return;
      await stats.updateAliases((f) => {
        let next = acceptGroup(f, keep, identity.name, identity.email);
        // Unticked identities are different people from the ticked ones.
        for (const other of leave) next = rejectMembers(next, [other, ...keep]);
        return next;
      });
      return;
    }
    case 'reject':
      return stats.updateAliases((f) => rejectMembers(f, s.members));
  }
}

async function handleAmbiguous(stats: StatsService, a: AmbiguousName): Promise<void> {
  const name = parseIdentityId(a.identity).name;
  const choice = await vscode.window.showQuickPick(
    [
      ...a.candidates.map((c) => ({ label: `$(link) Same person as ${parseIdentityId(c).name}`, description: parseIdentityId(c).email, candidate: c as string | undefined })),
      { label: '$(close) None of these', description: 'stop asking', candidate: undefined },
    ],
    { title: `Who is "${name}" <${parseIdentityId(a.identity).email}>?` },
  );
  if (!choice) return;
  if (choice.candidate) {
    const target = parseIdentityId(choice.candidate);
    const existing = stats.state.aliases.groups.find((g) => g.members.includes(choice.candidate!));
    await stats.updateAliases((f) => acceptGroup(f, [a.identity, choice.candidate!], existing?.name ?? target.name, existing?.email ?? target.email));
  } else {
    await stats.updateAliases((f) => a.candidates.reduce((next, c) => rejectMembers(next, [a.identity, c]), f));
  }
}

async function handleGroup(stats: StatsService, index: number): Promise<void> {
  const group = stats.state.aliases.groups[index];
  if (!group) return;
  const action = await vscode.window.showQuickPick(
    [
      { id: 'rename', label: '$(edit) Rename…' },
      { id: 'remove', label: '$(person) Remove an identity…', description: 'it will not be suggested for this group again' },
      { id: 'dissolve', label: '$(trash) Ungroup', description: 'suggestions may reappear' },
    ],
    { title: `${group.name} <${group.email}>` },
  );
  switch (action?.id) {
    case 'rename': {
      const identity = await askIdentity(group.name, group.email, group.members);
      if (identity) await stats.updateAliases((f) => renameGroup(f, index, identity.name, identity.email));
      return;
    }
    case 'remove': {
      const member = await vscode.window.showQuickPick(group.members, { title: 'Remove which identity from the group?' });
      if (!member) return;
      const rest = group.members.filter((m) => m !== member);
      await stats.updateAliases((f) => rejectMembers(removeFromGroup(f, index, member), [member, ...rest]));
      return;
    }
    case 'dissolve':
      return stats.updateAliases((f) => dissolveGroup(f, index));
  }
}

/** Lets the user pick one of the members' names/emails or type new ones. */
async function askIdentity(name: string, email: string, members: readonly string[]): Promise<{ name: string; email: string } | undefined> {
  const options = [...new Set(members.map((m) => parseIdentityId(m).name))];
  const pickedName = await vscode.window.showQuickPick(
    [...options.map((label) => ({ label })), { label: '$(edit) Type another name…' }],
    { title: 'Display name for this person', placeHolder: name },
  );
  if (!pickedName) return undefined;
  const finalName = pickedName.label.startsWith('$(edit)')
    ? await vscode.window.showInputBox({ title: 'Display name', value: name, validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty') })
    : pickedName.label;
  if (!finalName?.trim()) return undefined;

  const emails = [...new Set([email, ...members.map((m) => parseIdentityId(m).email)].filter(Boolean))];
  const pickedEmail = await vscode.window.showQuickPick(
    [...emails.map((label) => ({ label })), { label: '$(edit) Type another email…' }],
    { title: 'Primary email for this person' },
  );
  if (!pickedEmail) return undefined;
  const finalEmail = pickedEmail.label.startsWith('$(edit)')
    ? await vscode.window.showInputBox({ title: 'Primary email', value: email, validateInput: (v) => (/^[^\s<>@]+@[^\s<>@]+$/.test(v.trim()) ? undefined : 'Enter an email like name@example.com') })
    : pickedEmail.label;
  if (!finalEmail?.trim()) return undefined;
  return { name: finalName.trim(), email: finalEmail.trim() };
}

function describeIdentity(id: string, commitsOf: Map<string, number>): string {
  const n = commitsOf.get(id);
  return n === undefined ? id : `${id} (${n})`;
}
