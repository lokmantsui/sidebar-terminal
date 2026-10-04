// SVG viewer: wheel = zoom, drag = pan, click a link = open it in VS Code.
// Unlike other viewers it follows vscode://file/<abs>:<line> links (d2 / gps diagrams).
import * as vscode from 'vscode';

const open = async (href: string) => {
  const m = /^vscode:\/\/file(\/[^:?#]*)(?::(\d+))?(?::(\d+))?/.exec(href);
  if (!m) {
    if (/^https?:/.test(href)) vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const uri = vscode.Uri.file(decodeURIComponent(m[1]));
  if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
    return vscode.commands.executeCommand('revealInExplorer', uri);
  }
  const pos = new vscode.Position(Math.max(0, +(m[2] ?? 1) - 1), Math.max(0, +(m[3] ?? 1) - 1));
  // Beside, so the diagram stays visible.
  vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos) });
};

export const registerSvgViewer = () =>
  vscode.window.registerCustomEditorProvider('sidebarTerminal.svgViewer', {
    openCustomDocument: (uri) => ({ uri, dispose() {} }),
    async resolveCustomEditor(doc, panel) {
      panel.webview.options = { enableScripts: true };
      panel.webview.onDidReceiveMessage((href: string) => open(href).then(undefined, (e) => vscode.window.showWarningMessage(String(e))));
      const svg = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString('utf8');
      // Nonce-only script-src: scripts/handlers inside the SVG never run.
      const nonce = Math.random().toString(36).slice(2);
      panel.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body{margin:0;height:100%;overflow:hidden;cursor:grab;user-select:none}#s{transform-origin:0 0;width:max-content}a{cursor:pointer}</style>
</head><body><div id="s">${svg.replace(/^<\?xml[^>]*>/, '')}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi(), s = document.getElementById('s');
  let x = 0, y = 0, k = Math.min(1, innerWidth / s.offsetWidth, innerHeight / s.offsetHeight), drag = null, moved = false;
  const apply = () => (s.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + k + ')');
  apply();
  addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)); // ctrlKey = trackpad pinch
    x = e.clientX - (e.clientX - x) * f; y = e.clientY - (e.clientY - y) * f; k *= f;
    apply();
  }, { passive: false });
  addEventListener('pointerdown', (e) => { drag = { x: e.clientX - x, y: e.clientY - y, sx: e.clientX, sy: e.clientY }; moved = false; });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    moved ||= Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
    x = e.clientX - drag.x; y = e.clientY - drag.y;
    apply();
  });
  addEventListener('pointerup', () => (drag = null));
  addEventListener('dragstart', (e) => e.preventDefault());
  addEventListener('click', (e) => {
    const a = e.target.closest?.('a');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation(); // VS Code's own webview click handler would open the link a second time
    if (!moved) vscode.postMessage(a.getAttribute('href') || a.getAttribute('xlink:href'));
  }, true);
</script></body></html>`;
    },
  }, { webviewOptions: { retainContextWhenHidden: true } });
