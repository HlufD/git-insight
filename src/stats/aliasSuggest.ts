import { pairKey, type AliasFile } from './aliasFile';
import { emailLocalPart, nameTokens, normalizeName } from './identity';
import { jaroWinkler, jaroWinklerUpperBound } from './jaroWinkler';

export type AliasReason = 'same-email' | 'same-email-local-part' | 'similar-name' | 'name-subset';

export interface AliasCandidate {
  id: string;
  name: string;
  email: string;
  /** Used to pick the suggested display name. */
  commits: number;
}

export interface AliasSuggestion {
  /** Stable id: the sorted member ids joined. */
  key: string;
  members: string[];
  reasons: AliasReason[];
  suggestedName: string;
  suggestedEmail: string;
  /** Indexes of confirmed groups this suggestion would extend or join. */
  extendsGroups: number[];
}

/** A short name that fits several different people, so it is not grouped automatically. */
export interface AmbiguousName {
  identity: string;
  candidates: string[];
}

export interface AliasSuggestOptions {
  /** Jaro-Winkler threshold for normalized names. */
  threshold?: number;
}

interface Edge {
  a: string;
  b: string;
  reason: AliasReason;
}

const MIN_NAME_LENGTH = 3;

/**
 * Suggests which identities are the same person. Never merges anything by
 * itself: the caller shows the suggestions and the user decides.
 *
 * Rules, strongest first: same email, same email local-part, then fuzzy name
 * (normalized names with Jaro-Winkler >= threshold, or one name's tokens a subset
 * of the other's). Rejected pairs are never linked, even through a third identity.
 */
export function suggestAliases(
  candidates: readonly AliasCandidate[],
  aliases: AliasFile,
  options: AliasSuggestOptions = {},
): { suggestions: AliasSuggestion[]; ambiguous: AmbiguousName[] } {
  const threshold = options.threshold ?? 0.9;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const rejected = new Set(aliases.rejected.map(([a, b]) => pairKey(a, b)));
  const { edges, ambiguous } = findEdges(candidates, threshold);

  // Union-find with "cannot link" constraints from rejected pairs.
  const component = new Map<string, Set<string>>();
  for (const c of candidates) component.set(c.id, new Set([c.id]));
  const reasons = new Map<Set<string>, Set<AliasReason>>();

  const union = (a: string, b: string, reason?: AliasReason) => {
    const ca = component.get(a);
    const cb = component.get(b);
    if (!ca || !cb) return;
    if (ca === cb) {
      if (reason) reasonsOf(reasons, ca).add(reason);
      return;
    }
    for (const x of ca) for (const y of cb) if (rejected.has(pairKey(x, y))) return;
    const [big, small] = ca.size >= cb.size ? [ca, cb] : [cb, ca];
    const merged = reasonsOf(reasons, big);
    reasons.get(small)?.forEach((r) => merged.add(r));
    if (reason) merged.add(reason);
    for (const id of small) {
      big.add(id);
      component.set(id, big);
    }
    reasons.delete(small);
  };

  // Confirmed groups are already one person.
  aliases.groups.forEach((group) => {
    const present = group.members.filter((m) => byId.has(m));
    for (let i = 1; i < present.length; i++) union(present[0]!, present[i]!);
  });
  for (const edge of edges) union(edge.a, edge.b, edge.reason);

  const suggestions: AliasSuggestion[] = [];
  for (const members of new Set(component.values())) {
    if (members.size < 2) continue;
    const extendsGroups = aliases.groups
      .map((g, i) => (g.members.some((m) => members.has(m)) ? i : -1))
      .filter((i) => i !== -1);
    // Exactly a confirmed group (nothing new) → not a suggestion.
    const onlyConfirmed = extendsGroups.length === 1 && [...members].every((m) => aliases.groups[extendsGroups[0]!]!.members.includes(m));
    if (onlyConfirmed) continue;

    const sorted = [...members].sort();
    const group = extendsGroups.length ? aliases.groups[extendsGroups[0]!] : undefined;
    const top = sorted
      .map((id) => byId.get(id)!)
      .sort((x, y) => y.commits - x.commits || y.name.length - x.name.length || x.id.localeCompare(y.id))[0]!;
    suggestions.push({
      key: sorted.join('\n'),
      members: sorted,
      reasons: [...(reasons.get(members) ?? [])].sort(),
      suggestedName: group?.name ?? top.name,
      suggestedEmail: group?.email ?? top.email,
      extendsGroups,
    });
  }

  suggestions.sort((x, y) => y.members.length - x.members.length || x.key.localeCompare(y.key));

  // Once the user has grouped the short name or rejected every candidate, it is settled.
  const confirmed = new Set(aliases.groups.flatMap((g) => g.members));
  const openAmbiguous = ambiguous
    .filter((a) => !confirmed.has(a.identity))
    .map((a) => ({ ...a, candidates: a.candidates.filter((c) => !rejected.has(pairKey(a.identity, c))) }))
    .filter((a) => a.candidates.length > 0);
  return { suggestions, ambiguous: openAmbiguous };
}

function reasonsOf(map: Map<Set<string>, Set<AliasReason>>, key: Set<string>): Set<AliasReason> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
}

interface NameInfo {
  id: string;
  normalized: string;
  tokens: string[];
}

function findEdges(candidates: readonly AliasCandidate[], threshold: number): { edges: Edge[]; ambiguous: AmbiguousName[] } {
  const edges: Edge[] = [];

  // 1) Same email, 2) same local-part: link every identity in a bucket to the first one.
  const addBuckets = (keyOf: (c: AliasCandidate) => string | undefined, reason: AliasReason) => {
    const buckets = new Map<string, string[]>();
    for (const c of candidates) {
      const key = keyOf(c);
      if (!key) continue;
      const bucket = buckets.get(key) ?? [];
      bucket.push(c.id);
      buckets.set(key, bucket);
    }
    for (const ids of buckets.values()) for (let i = 1; i < ids.length; i++) edges.push({ a: ids[0]!, b: ids[i]!, reason });
  };
  addBuckets((c) => c.email.toLowerCase() || undefined, 'same-email');
  addBuckets((c) => emailLocalPart(c.email), 'same-email-local-part');

  // 3) Fuzzy names.
  const names: NameInfo[] = candidates
    .map((c) => {
      const normalized = normalizeName(c.name);
      return { id: c.id, normalized, tokens: nameTokens(normalized) };
    })
    .filter((n) => n.normalized.replace(/ /g, '').length >= MIN_NAME_LENGTH);

  const similar: Edge[] = [];
  const subsetsOf = new Map<string, NameInfo[]>(); // id of the shorter name → longer names containing it
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      // Subset is checked before similarity: "john" vs "john doe" also scores 0.9,
      // but must go through the ambiguity check below.
      if (sameTokens(a.tokens, b.tokens)) {
        similar.push({ a: a.id, b: b.id, reason: 'similar-name' }); // "Smith, John" / "John Smith"
      } else if (isTokenSubset(a.tokens, b.tokens)) {
        pushTo(subsetsOf, a.id, b);
      } else if (isTokenSubset(b.tokens, a.tokens)) {
        pushTo(subsetsOf, b.id, a);
      } else if (isSimilar(a.normalized, b.normalized, threshold)) {
        similar.push({ a: a.id, b: b.id, reason: 'similar-name' });
      }
    }
  }
  edges.push(...similar);

  // A short name contained in several different full names ("John" ⊂ "John Smith", "John Doe")
  // could be anyone, so it is reported instead of linked.
  const ambiguous: AmbiguousName[] = [];
  for (const [id, supersets] of subsetsOf) {
    const distinct = dedupeByNormalized(supersets);
    const allSamePerson = distinct.every((x, i) =>
      distinct.slice(i + 1).every((y) => isSimilar(x.normalized, y.normalized, threshold) || isTokenSubset(x.tokens, y.tokens) || isTokenSubset(y.tokens, x.tokens)),
    );
    if (allSamePerson) supersets.forEach((s) => edges.push({ a: id, b: s.id, reason: 'name-subset' }));
    else ambiguous.push({ identity: id, candidates: supersets.map((s) => s.id).sort() });
  }
  ambiguous.sort((x, y) => x.identity.localeCompare(y.identity));
  return { edges, ambiguous };
}

function isSimilar(a: string, b: string, threshold: number): boolean {
  if (a === b) return true;
  if (jaroWinklerUpperBound(a.length, b.length) < threshold) return false;
  return jaroWinkler(a, b) >= threshold;
}

/** True when every token of `small` is in `big` and `big` has more tokens. */
function isTokenSubset(small: string[], big: string[]): boolean {
  if (small.length === 0 || small.length >= big.length) return false;
  if (small.some((t) => t.length < MIN_NAME_LENGTH)) return false;
  return small.every((t) => big.includes(t));
}

function sameTokens(a: string[], b: string[]): boolean {
  return a.length > 1 && a.length === b.length && a.every((t) => b.includes(t));
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function dedupeByNormalized(infos: NameInfo[]): NameInfo[] {
  const seen = new Map<string, NameInfo>();
  for (const info of infos) if (!seen.has(info.normalized)) seen.set(info.normalized, info);
  return [...seen.values()];
}
