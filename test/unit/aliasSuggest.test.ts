import { describe, expect, it } from 'vitest';
import { acceptGroup, emptyAliasFile, rejectMembers, type AliasFile } from '../../src/stats/aliasFile';
import { suggestAliases, type AliasCandidate } from '../../src/stats/aliasSuggest';
import { identityId } from '../../src/stats/identity';

const person = (name: string, email: string, commits = 1): AliasCandidate => ({ id: identityId(name, email), name, email, commits });

describe('suggestAliases', () => {
  const bewuket = [
    person('bewuket', 'b1@laptop.local', 3),
    person('bewuket0', 'bewuket0@gmail.com', 2),
    person('Bewuket Baye', 'bewuket.baye@company.com', 10),
  ];

  it('groups "bewuket", "bewuket0" and "Bewuket Baye" as one suggestion', () => {
    const { suggestions } = suggestAliases(bewuket, emptyAliasFile());
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.members).toHaveLength(3);
    expect(suggestions[0]!.suggestedName).toBe('Bewuket Baye');
    expect(suggestions[0]!.suggestedEmail).toBe('bewuket.baye@company.com');
    expect(suggestions[0]!.reasons).toContain('name-subset');
  });

  it('links identities by same email and same local-part', () => {
    const { suggestions } = suggestAliases(
      [person('Alpha', 'x@a.com'), person('Totally Different', 'X@A.com'), person('Beta', '999+qwerty@users.noreply.github.com'), person('Gamma', 'qwerty@corp.com')],
      emptyAliasFile(),
    );
    expect(suggestions.map((s) => s.reasons)).toEqual([['same-email'], ['same-email-local-part']]);
  });

  it('matches reordered names and close spellings', () => {
    const { suggestions } = suggestAliases(
      [person('Smith, John', 's1@x.com'), person('John Smith', 's2@y.com'), person('Jon Smith', 's3@z.com')],
      emptyAliasFile(),
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.members).toHaveLength(3);
    expect(suggestions[0]!.reasons).toEqual(['similar-name']);
  });

  it('does not bridge two different people through a short shared name', () => {
    const { suggestions, ambiguous } = suggestAliases(
      [person('John', 'j@x.com'), person('John Smith', 'smith@y.com'), person('John Doe', 'doe@z.com')],
      emptyAliasFile(),
    );
    expect(suggestions).toEqual([]);
    expect(ambiguous).toEqual([{ identity: identityId('John', 'j@x.com'), candidates: [identityId('John Doe', 'doe@z.com'), identityId('John Smith', 'smith@y.com')].sort() }]);
  });

  it('ignores names too short to compare and unrelated people', () => {
    const { suggestions } = suggestAliases([person('Al', 'a1@x.com'), person('Al', 'a2@y.com'), person('Zed Zulu', 'z@x.com'), person('Mia Park', 'm@y.com')], emptyAliasFile());
    expect(suggestions).toEqual([]);
  });

  it('never suggests a rejected pair again, even through a third identity', () => {
    const first = suggestAliases(bewuket, emptyAliasFile()).suggestions[0]!;
    const rejected = rejectMembers(emptyAliasFile(), first.members);
    expect(suggestAliases(bewuket, rejected).suggestions).toEqual([]);

    const onePair: AliasFile = { ...emptyAliasFile(), rejected: [[bewuket[0]!.id, bewuket[2]!.id]] };
    const partial = suggestAliases(bewuket, onePair).suggestions;
    for (const s of partial) expect(s.members.includes(bewuket[0]!.id) && s.members.includes(bewuket[2]!.id)).toBe(false);
  });

  it('skips confirmed groups and suggests extending them with new identities', () => {
    const confirmed = acceptGroup(emptyAliasFile(), [bewuket[0]!.id, bewuket[2]!.id], 'Bewuket B.', 'bb@x.com');
    const onlyConfirmed = suggestAliases([bewuket[0]!, bewuket[2]!], confirmed);
    expect(onlyConfirmed.suggestions).toEqual([]);

    const withNew = suggestAliases(bewuket, confirmed).suggestions;
    expect(withNew).toHaveLength(1);
    expect(withNew[0]).toMatchObject({ extendsGroups: [0], suggestedName: 'Bewuket B.', suggestedEmail: 'bb@x.com' });
  });

  it('ignores group members that are not in the current data', () => {
    const confirmed = acceptGroup(emptyAliasFile(), ['Ghost <g@x.com>', 'Other <o@x.com>'], 'Ghost', 'g@x.com');
    expect(suggestAliases([person('Solo Person', 'solo@x.com')], confirmed).suggestions).toEqual([]);
  });

  it('respects a custom threshold', () => {
    const pair = [person('Jonathan Smith', 'a@x.com'), person('Jonathon Smyth', 'b@y.com')];
    expect(suggestAliases(pair, emptyAliasFile(), { threshold: 0.9 }).suggestions).toHaveLength(1);
    expect(suggestAliases(pair, emptyAliasFile(), { threshold: 0.99 }).suggestions).toHaveLength(0);
  });
});

describe('ambiguous names', () => {
  const people = [person('John', 'j@x.com'), person('John Smith', 'smith@y.com'), person('John Doe', 'doe@z.com')];
  const [john, smith, doe] = people.map((p) => p.id) as [string, string, string];

  it('drops candidates the user rejected and disappears once all are rejected', () => {
    let file = rejectMembers(emptyAliasFile(), [john, smith]);
    expect(suggestAliases(people, file).ambiguous[0]!.candidates).toEqual([doe]);
    file = rejectMembers(file, [john, doe]);
    expect(suggestAliases(people, file).ambiguous).toEqual([]);
  });

  it('disappears once the short name is in a confirmed group', () => {
    const file = acceptGroup(emptyAliasFile(), [john, smith], 'John Smith', 'smith@y.com');
    expect(suggestAliases(people, file).ambiguous).toEqual([]);
  });
});
