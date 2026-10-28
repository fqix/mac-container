// HTML shell for webview panels; the React app in webview-ui/ is built to dist/webview/webview.{js,css}

import * as vscode from 'vscode';

export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

/**
 * @param view which React view to render (see webview-ui/src/main.tsx)
 * @param data extra data-* attributes for <body>; `labels` is the localized string table
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: string, title: string, data: Record<string, string>): string {
  const root = webviewRoot(extensionUri);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'webview.css'));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const attributes = Object.entries({ view, locale: vscode.env.language, ...data })
    .map(([key, value]) => `data-${key}="${escape(value)}"`)
    .join(' ');
  return `<!DOCTYPE html>
<html lang="${escape(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${escape(title)}</title>
</head>
<body ${attributes}>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
