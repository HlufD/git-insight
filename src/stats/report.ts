import type { AliasFile } from './aliasFile';
import { suggestAliases, type AliasSuggestion, type AmbiguousName } from './aliasSuggest';
import { compileBotPatterns, isBot } from './identity';
import type { IdentityStats, RawStats } from './types';

/** One person in the report: a confirmed alias group or a single identity. */
export interface Contributor {
  /** `group:<index>` for alias groups, otherwise the identity id. */
  id: string;
  name: string;
  email: string;
  emails: string[];
  identities: string[];
  commits: number;
  merges: number;
  added: number;
  removed: number;
  binaryFiles: number;
  firstDate: string;
  firstTimestamp: number;
  lastDate: string;
  lastTimestamp: number;
  activeDays: number;
  weekly: Record<string, number>;
  bot: boolean;
}

export interface StatsReport {
  contributors: Contributor[];
  hiddenBots: number;
  suggestions: AliasSuggestion[];
  ambiguous: AmbiguousName[];
  invalidBotPatterns: string[];
  totals: { commits: number; merges: number; added: number; removed: number; binaryFiles: number };
}

export interface ReportOptions {
  excludeBots: boolean;
  botPatterns: readonly string[];
  aliasThreshold?: number;
}

/**
 * Applies alias groups and bot settings to raw scan results. Pure and cheap,
 * so changing aliases or settings never needs another git scan.
 */
export function buildReport(raw: RawStats, aliases: AliasFile, options: ReportOptions): StatsReport {
  const { regexes, invalid } = compileBotPatterns(options.botPatterns);
  const byId = new Map(raw.identities.map((s) => [s.id, s]));
  const botIds = new Set(raw.identities.filter((s) => isBot(s.name, s.email, regexes)).map((s) => s.id));

  const grouped = new Set<string>();
  const contributors: Contributor[] = [];
  aliases.groups.forEach((group, index) => {
    const members = group.members.map((m) => byId.get(m)).filter((s): s is IdentityStats => !!s && !grouped.has(s.id));
    if (members.length === 0) return;
    members.forEach((m) => grouped.add(m.id));
    contributors.push(combine(`group:${index}`, group.name, group.email, members, members.every((m) => botIds.has(m.id))));
  });
  for (const s of raw.identities) {
    if (!grouped.has(s.id)) contributors.push(combine(s.id, s.name, s.email, [s], botIds.has(s.id)));
  }

  const visible = options.excludeBots ? contributors.filter((c) => !c.bot) : contributors;
  visible.sort((a, b) => b.commits + b.merges - (a.commits + a.merges) || a.name.localeCompare(b.name));

  const candidates = raw.identities
    .filter((s) => !(options.excludeBots && botIds.has(s.id)))
    .map((s) => ({ id: s.id, name: s.name, email: s.email, commits: s.commits + s.merges }));
  const { suggestions, ambiguous } = suggestAliases(candidates, aliases, { threshold: options.aliasThreshold });

  const totals = { commits: 0, merges: 0, added: 0, removed: 0, binaryFiles: 0 };
  for (const c of visible) {
    totals.commits += c.commits;
    totals.merges += c.merges;
    totals.added += c.added;
    totals.removed += c.removed;
    totals.binaryFiles += c.binaryFiles;
  }

  return {
    contributors: visible,
    hiddenBots: contributors.length - visible.length,
    suggestions,
    ambiguous,
    invalidBotPatterns: invalid,
    totals,
  };
}

function combine(id: string, name: string, email: string, members: IdentityStats[], bot: boolean): Contributor {
  const days = new Set<string>();
  const weekly: Record<string, number> = {};
  const emails = new Set<string>();
  const c: Contributor = {
    id,
    name,
    email,
    emails: [],
    identities: members.map((m) => m.id).sort(),
    commits: 0,
    merges: 0,
    added: 0,
    removed: 0,
    binaryFiles: 0,
    firstDate: members[0]!.firstDate,
    firstTimestamp: Infinity,
    lastDate: members[0]!.lastDate,
    lastTimestamp: -Infinity,
    activeDays: 0,
    weekly,
    bot,
  };
  for (const m of members) {
    c.commits += m.commits;
    c.merges += m.merges;
    c.added += m.added;
    c.removed += m.removed;
    c.binaryFiles += m.binaryFiles;
    if (m.firstTimestamp < c.firstTimestamp) {
      c.firstTimestamp = m.firstTimestamp;
      c.firstDate = m.firstDate;
    }
    if (m.lastTimestamp > c.lastTimestamp) {
      c.lastTimestamp = m.lastTimestamp;
      c.lastDate = m.lastDate;
    }
    m.days.forEach((d) => days.add(d));
    for (const [week, count] of Object.entries(m.weekly)) weekly[week] = (weekly[week] ?? 0) + count;
    if (m.email) emails.add(m.email.toLowerCase());
  }
  c.activeDays = days.size;
  c.emails = [...emails].sort();
  return c;
}
