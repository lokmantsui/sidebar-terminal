const vscode = require('vscode');
const cp = require('child_process');
const os = require('os');
const path = require('path');

exports.activate = (ctx) => {
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('sidebarTerminal.view', {
    async resolveWebviewView(view) {
      // On window reload this view can be restored before the pi bridge activates; wait
      // (briefly) for it so the shell inherits PI_VSCODE_PORT from process.env.
      try { await vscode.extensions.getExtension('local.pi-vscode-context')?.activate(); } catch {}
      for (let i = 0; i < 20 && !process.env.PI_VSCODE_PORT; i++) await new Promise((r) => setTimeout(r, 100));

      const xterm = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@xterm');
      const uri = (p) => view.webview.asWebviewUri(vscode.Uri.joinPath(xterm, p));
      view.webview.options = { enableScripts: true, localResourceRoots: [xterm] };

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const proc = cp.spawn('python3', [path.join(ctx.extensionPath, 'ptyhost.py')], {
        cwd, env: { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }, stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
      });
      proc.stdout.on('data', (d) => view.webview.postMessage(d.toString('base64')));
      proc.on('exit', () => view.webview.postMessage(Buffer.from('\r\n[process exited]\r\n').toString('base64')));
      view.onDidDispose(() => proc.kill());
      let startup = vscode.workspace.getConfiguration('sidebarTerminal').get('startupCommand', '').trim();
      view.webview.onDidReceiveMessage((m) => {
        if (m.input !== undefined) return proc.stdin.write(m.input);
        proc.stdio[3].write(`${m.cols} ${m.rows}\n`);
        if (startup) { proc.stdin.write(startup + '\r'); startup = ''; } // after first resize so it starts at the right size
      });

      const csp = view.webview.cspSource;
      view.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline'; font-src ${csp};">
<link rel="stylesheet" href="${uri('xterm/css/xterm.css')}">
<style>html,body,#t{height:100%;margin:0;padding:0;overflow:hidden}body{padding:0 4px}</style>
</head><body><div id="t"></div>
<script src="${uri('xterm/lib/xterm.js')}"></script>
<script src="${uri('addon-fit/lib/addon-fit.js')}"></script>
<script>
  const vscode = acquireVsCodeApi();
  const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
  const term = new Terminal({
    fontFamily: css('--vscode-editor-font-family') || 'monospace',
    fontSize: parseInt(css('--vscode-editor-font-size')) || 13,
    theme: { background: css('--vscode-sideBar-background'), foreground: css('--vscode-terminal-foreground') || css('--vscode-foreground') },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  term.onData((input) => vscode.postMessage({ input }));
  term.onResize(({ cols, rows }) => vscode.postMessage({ cols, rows }));
  new ResizeObserver(() => fit.fit()).observe(document.body);
  window.addEventListener('message', (e) => term.write(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0))));
  fit.fit();
  vscode.postMessage({ cols: term.cols, rows: term.rows });
</script></body></html>`;
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
};
