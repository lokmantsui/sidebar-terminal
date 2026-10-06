import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { Readable, Writable } from 'stream';
import * as piContext from './picontext';

// python3 ptyhost.py: stdin/stdout pipes, stderr inherited, fd 3 = resize channel.
type PtyProc = cp.ChildProcessByStdio<Writable, Readable, null>;

type OpenPath = { url: string } | { search: string } | { path: string; line?: number; col?: number };

// Messages posted by the webview script below.
interface WebviewMsg {
  copy?: string;
  resolve?: string[];
  id?: number;
  openPath?: OpenPath;
  open?: string;
  paste?: boolean;
  input?: string;
  cols?: number;
  rows?: number;
}

// cwds of the shell and everything running under it (deepest first), e.g. pi's cwd — used to resolve relative paths.
const processCwds = (rootPid: number | undefined): string[] => {
  const out: string[] = [];
  const walk = (pid: number | string): void => {
    let kids: string[] = [];
    try { kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch {}
    kids.forEach(walk);
    try { out.push(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch {}
  };
  if (rootPid) walk(rootPid);
  return [...new Set(out)];
};

// The Claude Code extension only injects these into integrated terminals (environmentVariableCollection),
// so find its lock file for this window's workspace and pass them on ourselves.
const claudeIdeEnv = (): Record<string, string> => {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'ide');
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let best: { port: string; mtime: number } | undefined;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.lock')) continue;
      try {
        const file = path.join(dir, f);
        const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; workspaceFolders?: string[] };
        if (!lock.workspaceFolders?.some((w) => folders.includes(w))) continue;
        if (lock.pid) process.kill(lock.pid, 0); // throws if stale
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { port: path.basename(f, '.lock'), mtime };
      } catch {}
    }
  } catch {}
  return best ? { CLAUDE_CODE_SSE_PORT: best.port, ENABLE_IDE_INTEGRATION: 'true' } : {};
};

export const deactivate = (): void => piContext.deactivate();

export const activate = (ctx: vscode.ExtensionContext): void => {
  piContext.activate(ctx);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('sidebarTerminal.view', {
    async resolveWebviewView(view: vscode.WebviewView) {
      // The pi bridge's server listens asynchronously; wait (briefly) for it so the shell
      // inherits PI_VSCODE_PORT from process.env.
      for (let i = 0; i < 20 && !process.env.PI_VSCODE_PORT; i++) await new Promise((r) => setTimeout(r, 100));
      // Same for Claude Code: on window load its lock file appears a few seconds after we start.
      const claudeExt = vscode.extensions.getExtension('anthropic.claude-code');
      if (claudeExt) {
        await Promise.resolve(claudeExt.activate()).catch(() => {});
        for (let i = 0; i < 100 && !claudeIdeEnv().CLAUDE_CODE_SSE_PORT; i++) await new Promise((r) => setTimeout(r, 100));
      }

      const xterm = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@xterm');
      const uri = (p: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(xterm, p));
      view.webview.options = { enableScripts: true, localResourceRoots: [xterm] };

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const startupCmd = vscode.workspace.getConfiguration('sidebarTerminal').get<string>('startupCommand', '').trim();
      const send = (s: string) => view.webview.postMessage(Buffer.from(s).toString('base64'));
      let proc!: PtyProc;
      let size: string | undefined, disposed = false, exited = false;
      const resizeStream = () => proc.stdio[3] as Writable;
      const start = (): void => {
        exited = false;
        proc = cp.spawn('python3', [path.join(ctx.extensionPath, 'ptyhost.py')], {
          cwd, env: { ...process.env, ...claudeIdeEnv(), TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }, stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
        }) as PtyProc;
        const p = proc;
        p.stdout.on('data', (d: Buffer) => view.webview.postMessage(d.toString('base64')));
        p.on('exit', () => {
          if (disposed || p !== proc) return;
          exited = true;
          send('\r\n\x1b[2m[process exited \u2014 press any key to restart]\x1b[0m\r\n');
        });
        // Resize before the startup command so it starts at the right size; on first start we wait for the webview's size.
        if (size) { resizeStream().write(size); if (startupCmd) p.stdin.write(startupCmd + '\r'); }
      };
      start();
      view.onDidDispose(() => { disposed = true; proc.kill(); });
      // Opening the sidebar should put the cursor in the terminal (the webview then forwards focus to xterm).
      view.onDidChangeVisibility(() => { if (view.visible) view.show(false); });
      view.webview.onDidReceiveMessage(async (m: WebviewMsg) => {
        if (m.copy !== undefined) return vscode.env.clipboard.writeText(m.copy);
        if (m.resolve) {
          const bases = [...processCwds(proc?.pid), cwd];
          const results = await Promise.all(m.resolve.map(async (p): Promise<string | null> => {
            if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
            for (const f of path.isAbsolute(p) ? [p] : bases.map((b) => path.resolve(b, p))) {
              try { await fs.promises.stat(f); return f; } catch {}
            }
            return null;
          }));
          return view.webview.postMessage({ resolved: m.id, results });
        }
        const op = m.openPath;
        if (op && 'url' in op) return vscode.env.openExternal(vscode.Uri.parse(op.url));
        if (op && 'search' in op) return vscode.commands.executeCommand('workbench.action.quickOpen', op.search);
        if (op) {
          const u = vscode.Uri.file(op.path);
          if ((await fs.promises.stat(op.path)).isDirectory()) return vscode.commands.executeCommand('revealInExplorer', u);
          const line = Math.max(0, (op.line || 1) - 1), col = Math.max(0, (op.col || 1) - 1);
          return vscode.window.showTextDocument(u, op.line ? { selection: new vscode.Range(line, col, line, col) } : {});
        }
        if (m.open) {
          // file:// links (e.g. paths printed by pi) open in the editor; everything else externally.
          let u: vscode.Uri; try { u = vscode.Uri.parse(m.open, true); } catch { return; }
          return u.scheme === 'file' ? vscode.commands.executeCommand('vscode.open', u) : vscode.env.openExternal(u);
        }
        if (m.paste) return view.webview.postMessage({ paste: await vscode.env.clipboard.readText() });
        if (m.input !== undefined) {
          if (exited) { send('\x1bc'); return start(); } // reset screen, respawn shell
          return proc.stdin.write(m.input);
        }
        const first = !size;
        size = `${m.cols} ${m.rows}\n`;
        if (!exited) resizeStream().write(size);
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
<script src="${uri('addon-web-links/lib/addon-web-links.js')}"></script>
<script>${fs.readFileSync(path.join(ctx.extensionPath, 'out', 'webview', 'pathlinks.js'), 'utf8')}</script>
<script>
  const vscode = acquireVsCodeApi();
  const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
  // Like the integrated terminal: links open on Ctrl+click (Cmd+click on macOS).
  const openLink = (e, uri) => { if (e.ctrlKey || e.metaKey) vscode.postMessage({ open: uri }); };
  const term = new Terminal({
    linkHandler: { activate: openLink, allowNonHttpProtocols: true }, // OSC 8 hyperlinks
    fontFamily: css('--vscode-editor-font-family') || 'monospace',
    fontSize: parseInt(css('--vscode-editor-font-size')) || 13,
    theme: { background: css('--vscode-sideBar-background'), foreground: css('--vscode-terminal-foreground') || css('--vscode-foreground') },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink)); // plain-text URLs
  // File paths in plain text (verified to exist by the extension host).
  let reqId = 0;
  const pending = new Map();
  try { installPathLinks(term,
    (paths) => new Promise((res) => { pending.set(++reqId, res); vscode.postMessage({ resolve: paths, id: reqId }); }),
    (openPath) => vscode.postMessage({ openPath })); } catch (e) { console.error('path links disabled', e); }
  term.open(document.getElementById('t'));
  term.onData((input) => vscode.postMessage({ input }));
  // OSC 52 clipboard writes (pi copies its own mouse selections this way); reads ("?") are ignored.
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (b64 !== '?') {
      try { vscode.postMessage({ copy: new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) }); } catch {}
    }
    return true;
  });
  // Handle Cmd+C/V and Ctrl+Shift+C/V through VS Code's clipboard, including remote sessions.
  term.attachCustomKeyEventHandler((e) => {
    if (!((e.metaKey || (e.ctrlKey && e.shiftKey)) && !e.altKey && (e.code === 'KeyC' || e.code === 'KeyV'))) return true;
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
    if (e.data.resolved !== undefined) { pending.get(e.data.resolved)?.(e.data.results); return pending.delete(e.data.resolved); }
    if (e.data.paste !== undefined) return term.paste(e.data.paste); // handles bracketed paste mode
    term.write(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)));
  });
  // VS Code focuses the webview's window, not xterm's textarea; forward it so typing goes to the terminal.
  window.addEventListener('focus', () => term.focus());
  if (document.hasFocus()) term.focus(); // focus may have arrived before this script ran
  fit.fit();
  vscode.postMessage({ cols: term.cols, rows: term.rows });
</script></body></html>`;
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
};
