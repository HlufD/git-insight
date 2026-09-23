import { describe, expect, it } from 'vitest';
import { resolveTarget, symbolName, SymbolKinds as K, type EditorSnapshot, type SimpleSymbol } from '../../src/history/target';

const symbols: SimpleSymbol[] = [
  {
    name: 'Cart', kind: K.Class, startLine: 0, endLine: 30, children: [
      { name: 'items', kind: K.Property, startLine: 1, endLine: 1 },
      {
        name: 'get total', kind: K.Method, startLine: 3, endLine: 12, children: [
          { name: 'sum', kind: K.Variable, startLine: 4, endLine: 4 },
          { name: '<function>', kind: K.Function, startLine: 6, endLine: 8 },
        ],
      },
      { name: 'handlers', kind: K.Property, startLine: 14, endLine: 20 },
    ],
  },
  { name: 'helper', kind: K.Function, startLine: 32, endLine: 35 },
];

const at = (line: number, overrides: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  path: 'src/cart.ts', symbols, selection: { startLine: line, endLine: line, endCharacter: 0, text: '' }, modified: false, ...overrides,
});

describe('resolveTarget', () => {
  it('picks the innermost function around the cursor', () => {
    expect(resolveTarget(at(5))).toMatchObject({ name: 'total', range: { start: 4, end: 13 }, label: 'total()', preferName: false });
  });

  it('uses the range only for anonymous functions', () => {
    const t = resolveTarget(at(7));
    expect(t).toMatchObject({ name: undefined, range: { start: 7, end: 9 }, label: '<function>()' });
  });

  it('falls back to a multi-line value, then the class', () => {
    expect(resolveTarget(at(16))).toMatchObject({ name: 'handlers', range: { start: 15, end: 21 }, label: 'handlers' });
    expect(resolveTarget(at(1))).toMatchObject({ name: 'Cart', label: 'class Cart', symbolKind: K.Class });
  });

  it('prefers the name when the file has uncommitted changes', () => {
    expect(resolveTarget(at(33, { modified: true }))).toMatchObject({ name: 'helper', preferName: true });
  });

  it('uses the cursor line and word outside any symbol', () => {
    expect(resolveTarget(at(40, { wordAtCursor: 'config' }))).toEqual({ path: 'src/cart.ts', range: { start: 41, end: 41 }, searchTerm: 'config', preferName: false, label: 'line 41' });
    expect(resolveTarget(at(40, { wordAtCursor: '+=' })).searchTerm).toBeUndefined();
  });

  it('looks up a selected identifier’s definition in the file', () => {
    const t = resolveTarget(at(50, { selection: { startLine: 50, endLine: 50, endCharacter: 10, text: 'helper' } }));
    expect(t).toMatchObject({ name: 'helper', range: { start: 33, end: 36 }, label: 'helper()', preferName: false });
  });

  it('searches for a selected identifier that is not defined here', () => {
    const t = resolveTarget(at(50, { selection: { startLine: 50, endLine: 50, endCharacter: 10, text: 'fetchUser' } }));
    expect(t).toMatchObject({ name: 'fetchUser', range: { start: 51, end: 51 }, preferName: true, label: 'fetchUser' });
  });

  it('uses selected lines, ignoring a trailing line with nothing selected', () => {
    const t = resolveTarget(at(3, { selection: { startLine: 3, endLine: 6, endCharacter: 0, text: 'a\nb\nc\n' } }));
    expect(t).toMatchObject({ range: { start: 4, end: 6 }, label: 'lines 4–6' });
    expect(t.name).toBeUndefined();
    expect(t.searchTerm).toBeUndefined();
  });

  it('searches for single-line selected text on all branches', () => {
    const t = resolveTarget(at(3, { selection: { startLine: 3, endLine: 3, endCharacter: 20, text: 'return a + b;' } }));
    expect(t).toMatchObject({ range: { start: 4, end: 4 }, searchTerm: 'return a + b;', label: 'line 4' });
  });

  it('describes interfaces and enums', () => {
    const s = [{ name: 'Shape', kind: K.Interface, startLine: 0, endLine: 3 }, { name: 'Color', kind: K.Enum, startLine: 5, endLine: 8 }];
    expect(resolveTarget({ ...at(1), symbols: s }).label).toBe('interface Shape');
    expect(resolveTarget({ ...at(6), symbols: s }).label).toBe('enum Color');
  });
});

describe('symbolName', () => {
  it.each([
    ['add', 'add'], ['get total', 'total'], ['static async load', 'load'], ['render()', 'render'],
    ['(*Cart).Add', 'Add'], ['Foo::bar', 'bar'], ['Cart.prototype.add', 'add'], ['Foo#baz', 'baz'],
    ['<function>', undefined], ['then() callback', undefined], ['"quoted key"', undefined],
  ])('%s → %s', (raw, expected) => {
    expect(symbolName(raw)).toBe(expected);
  });
});
