import type { AliasFile } from './aliasFile';
import { parseIdentityId } from './identity';

/**
 * Builds `.mailmap` lines for confirmed groups. Entries match by commit email
 * (`Proper Name <proper@x> <commit@x>`), so every commit with that email is mapped.
 */
export function buildMailmapLines(aliases: AliasFile): string[] {
  const lines: string[] = [];
  for (const group of aliases.groups) {
    const properEmail = group.email.toLowerCase();
    const seen = new Set<string>();
    for (const member of group.members) {
      const { email } = parseIdentityId(member);
      const commitEmail = email.toLowerCase();
      if (!commitEmail || seen.has(commitEmail)) continue;
      seen.add(commitEmail);
      lines.push(
        commitEmail === properEmail
          ? `${group.name} <${group.email}>`
          : `${group.name} <${group.email}> <${commitEmail}>`,
      );
    }
  }
  return lines;
}

/**
 * Appends generated lines to existing `.mailmap` content, skipping lines that
 * are already there. Existing lines are never changed.
 */
export function mergeMailmap(existing: string, generated: readonly string[]): string {
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const additions = generated.filter((line) => !present.has(line.trim()));
  if (additions.length === 0) return existing;
  const base = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  const separator = base.length ? '\n' : '';
  return `${base}${separator}# Added by Git Insight\n${additions.join('\n')}\n`;
}
