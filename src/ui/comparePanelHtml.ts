// src/ui/comparePanelHtml.ts
// TASK-DBX03-004 — pure html shell for the compare panel. vscode-free
// so the scaffold hygiene guard holds for the whole compare path.

export interface PanelLike {
  asWebviewUri(uri: unknown): unknown;
  cspSource: string;
}

export function buildCompareHtml(
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
  <title>Compare Tables</title>
</head>
<body class="vsdb-form-body">
  <div id="vsdb-root" class="vsdb-compare"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
