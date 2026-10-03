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
      const startupCmd = vscode.workspace.getConfiguration('sidebarTerminal').get('startupCommand', '').trim();
      const send = (s) => view.webview.postMessage(Buffer.from(s).toString('base64'));
      let proc, size, disposed = false, exited = false;
      const start = () => {
        exited = false;
        proc = cp.spawn('python3', [path.join(ctx.extensionPath, 'ptyhost.py')], {
          cwd, env: { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }, stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
        });
        const p = proc;
        p.stdout.on('data', (d) => view.webview.postMessage(d.toString('base64')));
        p.on('exit', () => {
          if (disposed || p !== proc) return;
          exited = true;
          send('\r\n\x1b[2m[process exited \u2014 press any key to restart]\x1b[0m\r\n');
        });
        // Resize before the startup command so it starts at the right size; on first start we wait for the webview's size.
        if (size) { p.stdio[3].write(size); if (startupCmd) p.stdin.write(startupCmd + '\r'); }
      };
      start();
      view.onDidDispose(() => { disposed = true; proc.kill(); });
      view.webview.onDidReceiveMessage(async (m) => {
        if (m.copy !== undefined) return vscode.env.clipboard.writeText(m.copy);
        if (m.paste) return view.webview.postMessage({ paste: await vscode.env.clipboard.readText() });
        if (m.input !== undefined) {
          if (exited) { send('\x1bc'); return start(); } // reset screen, respawn shell
          return proc.stdin.write(m.input);
        }
        const first = !size;
        size = `${m.cols} ${m.rows}\n`;
        if (!exited) proc.stdio[3].write(size);
        if (first && startupCmd) proc.stdin.write(startupCmd + '\r');
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
  // xterm would turn Ctrl+Shift+C/V into ^C/^V; copy/paste via the extension host's clipboard instead.
  term.attachCustomKeyEventHandler((e) => {
    if (!(e.ctrlKey && e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyV'))) return true;
    if (e.type === 'keydown') {
      e.preventDefault();
      e.stopPropagation(); // don't let VS Code see it (Ctrl+Shift+C = open external terminal)
      if (e.code === 'KeyV') vscode.postMessage({ paste: true });
      else if (term.hasSelection()) vscode.postMessage({ copy: term.getSelection() });
    }
    return false;
  });
  term.onResize(({ cols, rows }) => vscode.postMessage({ cols, rows }));
  new ResizeObserver(() => fit.fit()).observe(document.body);
  window.addEventListener('message', (e) => {
    if (e.data.paste !== undefined) return term.paste(e.data.paste); // handles bracketed paste mode
    term.write(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)));
  });
  fit.fit();
  vscode.postMessage({ cols: term.cols, rows: term.rows });
</script></body></html>`;
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
};
