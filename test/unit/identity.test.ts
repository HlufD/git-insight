import { describe, expect, it } from 'vitest';
import { compileBotPatterns, emailLocalPart, identityId, isBot, nameTokens, normalizeName, parseIdentityId } from '../../src/stats/identity';
import { jaro, jaroWinkler, jaroWinklerUpperBound } from '../../src/stats/jaroWinkler';

describe('normalizeName', () => {
  it.each([
    ['bewuket', 'bewuket'],
    ['bewuket0', 'bewuket'],
    ['Bewuket Baye', 'bewuket baye'],
    ['Bewuket.Baye', 'bewuket baye'],
    ['BewuketBaye', 'bewuket baye'],
    ['Zoë  Ünïcode!!', 'zoe unicode'],
    ['1234', ''],
    ['Smith, John', 'smith john'],
    ['Абебе Бекеле', 'абебе бекеле'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it('splits into unique tokens', () => {
    expect(nameTokens('a b a')).toEqual(['a', 'b']);
    expect(nameTokens('')).toEqual([]);
  });
});

describe('identity ids', () => {
  it('lowercases the email and round-trips', () => {
    const id = identityId('Smith, John', 'John@Example.com');
    expect(id).toBe('Smith, John <john@example.com>');
    expect(parseIdentityId(id)).toEqual({ name: 'Smith, John', email: 'john@example.com' });
    expect(parseIdentityId('garbage')).toEqual({ name: 'garbage', email: '' });
  });
});

describe('emailLocalPart', () => {
  it.each([
    ['bewuket@example.com', 'bewuket'],
    ['Bewuket+work@example.com', 'bewuket'],
    ['12345+bewuket@users.noreply.github.com', 'bewuket'],
    ['noreply@github.com', undefined],
    ['root@localhost', undefined],
    ['ab@example.com', undefined],
    ['not-an-email', undefined],
    ['@example.com', undefined],
  ])('%s → %s', (email, expected) => {
    expect(emailLocalPart(email)).toBe(expected);
  });
});

describe('bot detection', () => {
  const { regexes, invalid } = compileBotPatterns(['\\[bot\\]', '^github-actions', 'dependabot', '(']);

  it('reports invalid patterns', () => {
    expect(invalid).toEqual(['(']);
  });

  it.each([
    ['dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com', true],
    ['github-actions', 'actions@github.com', true],
    ['Renovate Bot', 'bot@renovateapp.com', false],
    ['Bewuket Baye', 'bewuket@example.com', false],
  ])('%s <%s> → %s', (name, email, expected) => {
    expect(isBot(name, email, regexes)).toBe(expected);
  });
});

describe('jaroWinkler', () => {
  it('matches known reference values', () => {
    expect(jaro('MARTHA', 'MARHTA')).toBeCloseTo(0.9444, 4);
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
  });

  it('handles identical, empty and disjoint strings', () => {
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('upper bound is never below the real score', () => {
    const pairs = [['bewuket', 'bewuket baye'], ['john', 'jonathan'], ['a', 'abcdefghij'], ['same', 'same']] as const;
    for (const [a, b] of pairs) expect(jaroWinklerUpperBound(a.length, b.length)).toBeGreaterThanOrEqual(jaroWinkler(a, b));
    expect(jaroWinklerUpperBound(0, 0)).toBe(1);
    expect(jaroWinklerUpperBound(0, 3)).toBe(0);
  });
});
