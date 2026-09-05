// src/ui/erPanelHtml.ts — TASK-DBX04-003
// Pure CSP html shell for the ER panel. vscode-free so the scaffold
// hygiene guard holds. Mirrors comparePanelHtml: no nonce, cspSource
// script-src, 'unsafe-inline' style only.

export interface PanelLike {
  asWebviewUri(uri: unknown): unknown;
  cspSource: string;
}

export function buildErHtml(
  webview: PanelLike,
  scriptName: string,
  styleName: string,
): string {
  const scriptUri = webview.asWebviewUri(["dist", scriptName].join("/"));
  const styleUri = webview.asWebviewUri(["dist", styleName].join("/"));
  const cspSource = webview.cspSource;
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Relationship Explorer</title>
</head>
<body class="UnicDB-form-body">
  <div id="UnicDB-root" class="UnicDB-er"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
