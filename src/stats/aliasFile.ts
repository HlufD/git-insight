import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** A confirmed "these identities are one person" group. Members are identity ids. */
export interface AliasGroup {
  name: string;
  email: string;
  members: string[];
}

/** Contents of `.gitinsight/aliases.json`. */
export interface AliasFile {
  version: 1;
  groups: AliasGroup[];
  /** Identity pairs the user said are NOT the same person; never suggested again. */
  rejected: [string, string][];
}

export const ALIAS_FILE_PATH = '.gitinsight/aliases.json';

export class AliasFileError extends Error {}

export function emptyAliasFile(): AliasFile {
  return { version: 1, groups: [], rejected: [] };
}

/** Validates and parses the alias file. Throws {@link AliasFileError} with a readable reason. */
export function parseAliasFile(text: string): AliasFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new AliasFileError(`${ALIAS_FILE_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(data)) throw new AliasFileError(`${ALIAS_FILE_PATH} must contain a JSON object.`);
  if (data.version !== 1) {
    throw new AliasFileError(`${ALIAS_FILE_PATH} has unsupported version ${JSON.stringify(data.version)}; expected 1.`);
  }

  const groups = data.groups ?? [];
  if (!Array.isArray(groups)) throw new AliasFileError('"groups" must be an array.');
  const parsedGroups = groups.map((g, i): AliasGroup => {
    if (!isObject(g) || typeof g.name !== 'string' || typeof g.email !== 'string' || !isStringArray(g.members)) {
      throw new AliasFileError(`groups[${i}] needs "name", "email" and a "members" string array.`);
    }
    return { name: g.name, email: g.email, members: [...new Set(g.members)] };
  });

  const rejected = data.rejected ?? [];
  if (!Array.isArray(rejected) || !rejected.every((p) => isStringArray(p) && p.length === 2)) {
    throw new AliasFileError('"rejected" must be an array of [identity, identity] pairs.');
  }
  return { version: 1, groups: parsedGroups, rejected: rejected as [string, string][] };
}

export function serializeAliasFile(file: AliasFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Reads the alias file from a repo; a missing file is an empty one. */
export async function readAliasFile(repoRoot: string): Promise<AliasFile> {
  const file = path.join(repoRoot, ALIAS_FILE_PATH);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAliasFile();
    throw error;
  }
  return parseAliasFile(text);
}

export async function writeAliasFile(repoRoot: string, aliases: AliasFile): Promise<void> {
  const file = path.join(repoRoot, ALIAS_FILE_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, serializeAliasFile(aliases), 'utf8');
  await fs.rename(temp, file);
}

/** Order-independent key for an identity pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/** Records every cross pair among `members` as rejected (skipping pairs already confirmed together). */
export function rejectMembers(file: AliasFile, members: readonly string[]): AliasFile {
  const confirmedTogether = new Set<string>();
  for (const group of file.groups) {
    for (const a of group.members) for (const b of group.members) if (a !== b) confirmedTogether.add(pairKey(a, b));
  }
  const existing = new Set(file.rejected.map(([a, b]) => pairKey(a, b)));
  const rejected = [...file.rejected];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const key = pairKey(members[i]!, members[j]!);
      if (existing.has(key) || confirmedTogether.has(key)) continue;
      existing.add(key);
      rejected.push(members[i]! < members[j]! ? [members[i]!, members[j]!] : [members[j]!, members[i]!]);
    }
  }
  return { ...file, rejected };
}

/**
 * Confirms `members` as one person named `name <email>`. Existing groups that share
 * a member are merged in; members are removed from any other group first.
 */
export function acceptGroup(file: AliasFile, members: readonly string[], name: string, email: string): AliasFile {
  const memberSet = new Set(members);
  const merged = new Set(members);
  const groups: AliasGroup[] = [];
  for (const group of file.groups) {
    if (group.members.some((m) => memberSet.has(m))) group.members.forEach((m) => merged.add(m));
    else groups.push(group);
  }
  groups.push({ name, email, members: [...merged].sort() });
  const rejected = file.rejected.filter(([a, b]) => !(merged.has(a) && merged.has(b)));
  return { ...file, groups, rejected };
}

/** Removes a member from a group; a group left with fewer than two members is dissolved. */
export function removeFromGroup(file: AliasFile, groupIndex: number, member: string): AliasFile {
  const groups = file.groups
    .map((g, i) => (i === groupIndex ? { ...g, members: g.members.filter((m) => m !== member) } : g))
    .filter((g) => g.members.length >= 2);
  return { ...file, groups };
}

export function renameGroup(file: AliasFile, groupIndex: number, name: string, email: string): AliasFile {
  return { ...file, groups: file.groups.map((g, i) => (i === groupIndex ? { ...g, name, email } : g)) };
}

export function dissolveGroup(file: AliasFile, groupIndex: number): AliasFile {
  return { ...file, groups: file.groups.filter((_, i) => i !== groupIndex) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
