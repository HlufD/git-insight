import * as vscode from 'vscode';
import type { PersonAvatar } from '../services/AvatarService';

/** Hover card header: avatar, name, @username and email. */
export function personTooltip(name: string, emails: string[], avatar: PersonAvatar): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = true;
  if (avatar.imageUrl) md.appendMarkdown(`<img src="${escapeAttr(avatar.imageUrl)}" width="56" height="56"/>\n\n`);
  md.appendMarkdown(`**${escapeMd(name)}**`);
  if (avatar.login && avatar.profileUrl) md.appendMarkdown(` · [@${escapeMd(avatar.login)}](${avatar.profileUrl})`);
  md.appendMarkdown('\n\n');
  if (emails.length) md.appendMarkdown(`$(mail) ${emails.map(escapeMd).join(', ')}\n\n`);
  return md;
}

export function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|$~]/g, '\\$&');
}

function escapeAttr(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
