const SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c,
};

/**
 * Undoes git's C-style path quoting (`"dir/\303\251t\303\251.txt"`).
 * Unquoted input is returned unchanged. Octal escapes are UTF-8 bytes.
 */
export function unquoteCPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next]!);
      i += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
