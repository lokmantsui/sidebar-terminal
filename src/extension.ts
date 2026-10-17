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

// Messages posted by src/webview/terminal.ts.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => boolean, timeoutMs: number) => {
  for (let t = 0; t < timeoutMs && !cond(); t += 100) await sleep(100);
};
const workspaceDirs = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

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
  const folders = workspaceDirs();
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

// The shell inherits its IDE integration env at spawn time, so give both bridges a moment to come up.
const waitForIdeEnv = async (): Promise<void> => {
  // The pi bridge's server listens asynchronously and then sets PI_VSCODE_PORT in process.env.
  await waitUntil(() => !!process.env.PI_VSCODE_PORT, 2000);
  // On window load, Claude Code's lock file appears a few seconds after we start.
  const claudeExt = vscode.extensions.getExtension('anthropic.claude-code');
  if (claudeExt) {
    await Promise.resolve(claudeExt.activate()).catch(() => {});
    await waitUntil(() => !!claudeIdeEnv().CLAUDE_CODE_SSE_PORT, 10000);
  }
};

// First existing match of `p` (absolute, ~/..., or relative to one of `dirs`), or null.
const resolvePath = async (p: string, dirs: string[]): Promise<string | null> => {
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  for (const f of path.isAbsolute(p) ? [p] : dirs.map((d) => path.resolve(d, p))) {
    try { await fs.promises.stat(f); return f; } catch {}
  }
  return null;
};

// Splits a scheme-less link like "(src/a.ts#L10-L20)" or "src/a.ts:10:5" into path, line and column.
const parseRelativeLink = (link: string): { path: string; line?: number; col?: number } => {
  let s: string;
  try { s = decodeURI(link); } catch { s = link; }
  const [, p, l1, c1, l2, c2] = s.replace(/^\(|\)$/g, '')
    .match(/^(.*?)(?:#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::(\d+))?)?$/)!;
  const line = l1 ?? l2, col = c1 ?? c2;
  return { path: p, line: line ? +line : undefined, col: col ? +col : undefined };
};

const openTarget = async (op: OpenPath): Promise<unknown> => {
  if ('url' in op) return vscode.env.openExternal(vscode.Uri.parse(op.url));
  if ('search' in op) return vscode.commands.executeCommand('workbench.action.quickOpen', op.search);
  const u = vscode.Uri.file(op.path);
  if ((await fs.promises.stat(op.path)).isDirectory()) return vscode.commands.executeCommand('revealInExplorer', u);
  const line = Math.max(0, (op.line || 1) - 1), col = Math.max(0, (op.col || 1) - 1);
  return vscode.window.showTextDocument(u, op.line ? { selection: new vscode.Range(line, col, line, col) } : {});
};

// A clicked OSC 8 / plain-text link.
const openLink = async (link: string, dirs: string[]): Promise<unknown> => {
  // OSC 8 links without a scheme (e.g. Claude Code's markdown links) are relative paths.
  if (!/^[a-z][\w+.-]*:/i.test(link)) {
    const { path: p, line, col } = parseRelativeLink(link);
    const resolved = await resolvePath(p, dirs);
    return openTarget(resolved ? { path: resolved, line, col } : { search: p });
  }
  // file:// links (e.g. paths printed by pi) open in the editor; everything else externally.
  let u: vscode.Uri;
  try { u = vscode.Uri.parse(link, true); } catch { return; }
  return u.scheme === 'file' ? vscode.commands.executeCommand('vscode.open', u) : vscode.env.openExternal(u);
};

// The shell running under ptyhost.py. After it exits, the next keypress starts a fresh one.
class Shell {
  private proc!: PtyProc;
  private size?: string; // last "cols rows\n" from the webview; unknown until it first reports
  private exited = false;
  private disposed = false;

  constructor(
    private readonly script: string,
    private readonly cwd: string,
    private readonly startupCmd: string,
    private readonly output: (data: string | Buffer) => void,
  ) {
    this.start();
  }

  get pid(): number | undefined { return this.proc.pid; }

  private start(): void {
    this.exited = false;
    const p = this.proc = cp.spawn('python3', [this.script], {
      cwd: this.cwd,
      env: { ...process.env, ...claudeIdeEnv(), TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' },
      stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    }) as PtyProc;
    p.stdout.on('data', this.output);
    p.on('exit', () => {
      if (this.disposed || p !== this.proc) return;
      this.exited = true;
      this.output('\r\n\x1b[2m[process exited — press any key to restart]\x1b[0m\r\n');
    });
    // Resize before the startup command so it starts at the right size; on first start, resize() does this.
    if (this.size) { this.writeSize(); this.runStartupCmd(); }
  }

  input(data: string): void {
    if (!this.exited) { this.proc.stdin.write(data); return; }
    this.output('\x1bc'); // reset screen
    this.start();
  }

  resize(cols: number, rows: number): void {
    const first = !this.size;
    this.size = `${cols} ${rows}\n`;
    if (!this.exited) this.writeSize();
    if (first) this.runStartupCmd();
  }

  dispose(): void {
    this.disposed = true;
    this.proc.kill();
  }

  private writeSize(): void { (this.proc.stdio[3] as Writable).write(this.size); }
  private runStartupCmd(): void { if (this.startupCmd) this.proc.stdin.write(this.startupCmd + '\r'); }
}

const webviewHtml = (webview: vscode.Webview, extensionPath: string, xtermRoot: vscode.Uri): string => {
  const csp = webview.cspSource;
  const xterm = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(xtermRoot, p));
  const inline = (name: string) => fs.readFileSync(path.join(extensionPath, 'out', 'webview', name), 'utf8');
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline'; font-src ${csp};">
<link rel="stylesheet" href="${xterm('xterm/css/xterm.css')}">
<style>html,body,#t{height:100%;margin:0;padding:0;overflow:hidden}body{padding:0 4px}</style>
</head><body><div id="t"></div>
<script src="${xterm('xterm/lib/xterm.js')}"></script>
<script src="${xterm('addon-fit/lib/addon-fit.js')}"></script>
<script src="${xterm('addon-web-links/lib/addon-web-links.js')}"></script>
<script>${inline('pathlinks.js')}</script>
<script>${inline('terminal.js')}</script>
</body></html>`;
};

const resolveWebviewView = async (ctx: vscode.ExtensionContext, view: vscode.WebviewView): Promise<void> => {
  await waitForIdeEnv();

  const xtermRoot = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@xterm');
  view.webview.options = { enableScripts: true, localResourceRoots: [xtermRoot] };

  const cwd = workspaceDirs()[0] || os.homedir();
  const startupCmd = vscode.workspace.getConfiguration('sidebarTerminal').get<string>('startupCommand', '').trim();
  const shell = new Shell(path.join(ctx.extensionPath, 'ptyhost.py'), cwd, startupCmd,
    (data) => view.webview.postMessage(Buffer.from(data).toString('base64')));
  view.onDidDispose(() => shell.dispose());

  // Opening the sidebar should put the cursor in the terminal (the webview then forwards focus to xterm).
  view.onDidChangeVisibility(() => { if (view.visible) view.show(false); });

  // Where relative paths in terminal output may live: the shell's (and its children's) cwds, then the workspace.
  const searchDirs = () => [...processCwds(shell.pid), cwd, ...workspaceDirs()];

  view.webview.onDidReceiveMessage(async (m: WebviewMsg) => {
    if (m.copy !== undefined) return vscode.env.clipboard.writeText(m.copy);
    if (m.paste) return view.webview.postMessage({ paste: await vscode.env.clipboard.readText() });
    if (m.input !== undefined) return shell.input(m.input);
    if (m.openPath) return openTarget(m.openPath);
    if (m.open) return openLink(m.open, searchDirs());
    if (m.resolve) {
      const dirs = searchDirs();
      const results = await Promise.all(m.resolve.map((p) => resolvePath(p, dirs)));
      return view.webview.postMessage({ resolved: m.id, results });
    }
    if (m.cols && m.rows) shell.resize(m.cols, m.rows);
  });

  view.webview.html = webviewHtml(view.webview, ctx.extensionPath, xtermRoot);
};

export const deactivate = (): void => piContext.deactivate();

export const activate = (ctx: vscode.ExtensionContext): void => {
  piContext.activate(ctx);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('sidebarTerminal.view', {
    resolveWebviewView: (view) => resolveWebviewView(ctx, view),
  }, { webviewOptions: { retainContextWhenHidden: true } }));
};
