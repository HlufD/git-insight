/** Stable key for a name/email pair. Emails compare case-insensitively. */
export function identityId(name: string, email: string): string {
  return `${name} <${email.toLowerCase()}>`;
}

/** Splits an identity id back into name and email. */
export function parseIdentityId(id: string): { name: string; email: string } {
  const match = /^(.*) <([^<>]*)>$/.exec(id);
  return match ? { name: match[1]!, email: match[2]! } : { name: id, email: '' };
}

/**
 * Lowercases, removes accents and digits, turns punctuation into spaces and
 * splits camelCase: "Bewuket.Baye0" and "BewuketBaye" both become "bewuket baye".
 */
export function normalizeName(name: string): string {
  return name
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\p{N}/gu, '')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim();
}

export function nameTokens(normalized: string): string[] {
  return normalized ? [...new Set(normalized.split(' '))] : [];
}

const GENERIC_LOCAL_PARTS = new Set([
  'admin', 'contact', 'dev', 'developer', 'git', 'github', 'gitlab', 'hello', 'info', 'mail',
  'me', 'no-reply', 'noreply', 'pi', 'root', 'support', 'test', 'ubuntu', 'user',
]);

/**
 * The part of an email that identifies a person, or undefined if it is generic.
 * GitHub's `12345+name@users.noreply.github.com` yields `name`; `+tags` are dropped.
 */
export function emailLocalPart(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at <= 0) return undefined;
  let local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  const plus = local.indexOf('+');
  if (plus !== -1) {
    local = domain === 'users.noreply.github.com' ? local.slice(plus + 1) : local.slice(0, plus);
  }
  if (local.length < 3 || GENERIC_LOCAL_PARTS.has(local)) return undefined;
  return local;
}

/** Compiles bot patterns (case-insensitive); invalid patterns are skipped and reported. */
export function compileBotPatterns(patterns: readonly string[]): { regexes: RegExp[]; invalid: string[] } {
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern, 'i'));
    } catch {
      invalid.push(pattern);
    }
  }
  return { regexes, invalid };
}

export function isBot(name: string, email: string, regexes: readonly RegExp[]): boolean {
  return regexes.some((re) => re.test(name) || re.test(email));
}
