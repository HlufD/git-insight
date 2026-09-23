import { createHash } from 'node:crypto';

/** GitHub account encoded in a noreply email: `12345+octocat@users.noreply.github.com` or `octocat@users.noreply.github.com`. */
export function githubUserFromEmail(email: string): { login: string; id?: number } | undefined {
  const match = /^(?:(\d+)\+)?([a-z\d](?:[a-z\d-]{0,38}))@users\.noreply\.github\.com$/i.exec(email.trim());
  if (!match) return undefined;
  return { login: match[2]!, id: match[1] ? Number(match[1]) : undefined };
}

/** `owner/repo` of a github.com remote (https, ssh or scp-style), else undefined. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** Up to two initials: first letters of the first and last words ("Smith, John" → "SJ"). */
export function initials(name: string): string {
  const words = name
    .normalize('NFC')
    .split(/[\s,._\-]+/)
    .map((w) => Array.from(w).filter((ch) => /\p{L}/u.test(ch)).join(''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0]!)[0]!;
  const last = words.length > 1 ? Array.from(words.at(-1)!)[0]! : '';
  return (first + last).toLocaleUpperCase();
}

/** Background colours that keep white initials readable (contrast ≥ 4.5:1). */
const AVATAR_COLORS = ['#0550ae', '#8250df', '#bf3989', '#cf222e', '#9a3a00', '#1a7f37', '#6639ba', '#0e7490'];

/** Stable colour for a person, so the same author always looks the same. */
export function avatarColor(key: string): string {
  let hash = 2166136261;
  for (const ch of key.toLowerCase()) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length]!;
}

export function initialsSvg(name: string, key: string): string {
  const text = escapeXml(initials(name));
  const size = text.length > 1 ? 13 : 15;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${avatarColor(key)}"/><text x="16" y="16" dy="0.35em" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="600" fill="#ffffff">${text}</text></svg>`;
}

/** Wraps a downloaded image in a circular SVG so it looks like the initials avatars. */
export function circularImageSvg(image: Buffer, mime: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><clipPath id="c"><circle cx="16" cy="16" r="16"/></clipPath></defs><image href="data:${mime};base64,${image.toString('base64')}" width="32" height="32" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/></svg>`;
}

export function gravatarUrl(email: string, size: number): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

export function emailKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
