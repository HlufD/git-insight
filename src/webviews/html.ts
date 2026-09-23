import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * HTML shell for a webview: strict CSP with a fresh nonce, local scripts and
 * styles only. Everything dynamic is rendered by the script from messages.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, options: { title: string; script: string; style: string }): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dist', options.script));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', options.style));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>${escapeHtml(options.title)}</title>
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Loading…</p></main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
