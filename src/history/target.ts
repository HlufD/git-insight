import type { HistoryTarget } from './codeHistory';

/** The same numbers as `vscode.SymbolKind` (File = 0), so this module stays free of `vscode`. */
export const SymbolKinds = {
  Module: 1, Namespace: 2, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9,
  Interface: 10, Function: 11, Variable: 12, Constant: 13, Object: 18, Struct: 22,
} as const;

/** A document symbol reduced to what we need; lines are 0-based and inclusive. */
export interface SimpleSymbol {
  name: string;
  kind: number;
  startLine: number;
  endLine: number;
  children?: SimpleSymbol[];
}

export interface EditorSnapshot {
  /** Repo-relative path with forward slashes. */
  path: string;
  symbols: SimpleSymbol[];
  /** 0-based selection; `text` is the selected text (empty when nothing is selected). */
  selection: { startLine: number; endLine: number; endCharacter: number; text: string };
  /** Identifier under the cursor, if any. */
  wordAtCursor?: string;
  /** The editor's file differs from HEAD (unsaved or uncommitted changes). */
  modified: boolean;
}

export interface ResolvedTarget extends HistoryTarget {
  /** Short description for the UI: `add()`, `class Cart`, `lines 3–9`. */
  label: string;
  symbolKind?: number;
}

const CALLABLE = new Set<number>([SymbolKinds.Function, SymbolKinds.Method, SymbolKinds.Constructor]);
const VALUE = new Set<number>([SymbolKinds.Variable, SymbolKinds.Constant, SymbolKinds.Property, SymbolKinds.Field, SymbolKinds.Object]);
const TYPE = new Set<number>([SymbolKinds.Class, SymbolKinds.Interface, SymbolKinds.Enum, SymbolKinds.Struct]);
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/**
 * Decides what "this" is in "who wrote this?":
 * - a selected identifier → that name (and its definition in the file, if any);
 * - any other selection → those lines (single-line text is still searched on all branches);
 * - no selection → the innermost function around the cursor, else a multi-line
 *   value (arrow function, object), else the enclosing class; else the cursor's line.
 */
export function resolveTarget(editor: EditorSnapshot): ResolvedTarget {
  const { selection, symbols, path, modified } = editor;
  const all = flatten(symbols);
  const selected = selection.text.trim();

  if (selected && selection.startLine === selection.endLine && IDENTIFIER.test(selected)) {
    const definition = all.find((s) => symbolName(s.name) === selected);
    const lines = definition ? { start: definition.startLine, end: definition.endLine } : { start: selection.startLine, end: selection.endLine };
    return {
      path,
      name: selected,
      range: toRange(lines),
      preferName: modified || !definition,
      label: definition ? describe(definition, selected) : selected,
      symbolKind: definition?.kind,
    };
  }

  if (selected) {
    const endLine = selection.endLine > selection.startLine && selection.endCharacter === 0 ? selection.endLine - 1 : selection.endLine;
    const range = toRange({ start: selection.startLine, end: endLine });
    const singleLine = range.start === range.end && !selected.includes('\n');
    return {
      path,
      range,
      searchTerm: singleLine ? selected : undefined,
      preferName: false,
      label: range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`,
    };
  }

  const chain = all
    .filter((s) => s.startLine <= selection.startLine && s.endLine >= selection.startLine)
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine));
  const symbol =
    innermost(chain, (s) => CALLABLE.has(s.kind)) ??
    innermost(chain, (s) => VALUE.has(s.kind) && s.endLine > s.startLine) ??
    innermost(chain, (s) => TYPE.has(s.kind));

  if (symbol) {
    const name = symbolName(symbol.name);
    return {
      path,
      name,
      range: toRange({ start: symbol.startLine, end: symbol.endLine }),
      preferName: modified,
      label: describe(symbol, name ?? symbol.name),
      symbolKind: symbol.kind,
    };
  }

  const word = editor.wordAtCursor && IDENTIFIER.test(editor.wordAtCursor) ? editor.wordAtCursor : undefined;
  const line = selection.startLine + 1;
  return { path, range: { start: line, end: line }, searchTerm: word, preferName: false, label: `line ${line}` };
}

/**
 * The plain identifier in a language server's symbol name: `get total` → `total`,
 * `(*Cart).Add` → `Add`, `Foo::bar` → `bar`. Anonymous names like `<function>` → undefined.
 */
export function symbolName(raw: string): string | undefined {
  const cleaned = raw.replace(/^((get|set|static|async|public|private|protected|readonly)\s+)+/, '').replace(/\(\)$/, '').trim();
  if (IDENTIFIER.test(cleaned)) return cleaned;
  const qualified = /^(?:\(\*?[\p{L}\p{N}_$]+\)\.|[\p{L}\p{N}_$]+(?:\.|::|#))+([\p{L}_$][\p{L}\p{N}_$]*)$/u.exec(cleaned);
  return qualified?.[1];
}

function flatten(symbols: SimpleSymbol[]): SimpleSymbol[] {
  return symbols.flatMap((s) => [s, ...flatten(s.children ?? [])]);
}

function innermost(chain: SimpleSymbol[], predicate: (s: SimpleSymbol) => boolean): SimpleSymbol | undefined {
  return chain.filter(predicate).at(-1);
}

function toRange(lines: { start: number; end: number }): { start: number; end: number } {
  return { start: lines.start + 1, end: Math.max(lines.start, lines.end) + 1 };
}

function describe(symbol: SimpleSymbol, name: string): string {
  if (CALLABLE.has(symbol.kind)) return `${name}()`;
  if (symbol.kind === SymbolKinds.Class) return `class ${name}`;
  if (symbol.kind === SymbolKinds.Interface) return `interface ${name}`;
  if (symbol.kind === SymbolKinds.Enum) return `enum ${name}`;
  return name;
}
