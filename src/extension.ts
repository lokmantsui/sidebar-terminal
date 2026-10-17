import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { Readable, Writable } from 'stream';
import { Deferred, Effect, Exit, FiberSet, Schedule, Scope } from 'effect';
import * as piContext from './picontext';
import { disposable, thenable } from './scoped';

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

const waitUntil = (cond: () => boolean, timeout: `${number} seconds`) => Effect.sync(cond).pipe(
  Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced('100 millis') }),
  Effect.timeoutOption(timeout),
);
const workspaceDirs = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

// rootPid and everything running under it, deepest first.
const processTree = (rootPid: number | undefined): string[] => {
  const out: string[] = [];
  const walk = (pid: string): void => {
    let kids: string[] = [];
    try { kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch {}
    kids.forEach(walk);
    out.push(pid);
  };
  if (rootPid) walk(String(rootPid));
  return out;
};

// cwds of the shell and everything running under it (deepest first), e.g. pi's cwd — used to resolve relative paths.
const processCwds = (rootPid: number | undefined): string[] => [...new Set(processTree(rootPid).flatMap((pid) => {
  try { return [fs.readlinkSync(`/proc/${pid}/cwd`)]; } catch { return []; }
}))];

const runsClaude = (rootPid: number | undefined): boolean => processTree(rootPid).some((pid) => {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'claude'; } catch { return false; }
});

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
const waitForIdeEnv = Effect.gen(function* () {
  // The pi bridge's server listens asynchronously and then sets PI_VSCODE_PORT in process.env.
  yield* waitUntil(() => !!process.env.PI_VSCODE_PORT, '2 seconds');
  // On window load, Claude Code's lock file appears a few seconds after we start.
  const claudeExt = vscode.extensions.getExtension('anthropic.claude-code');
  if (claudeExt) {
    yield* thenable(() => claudeExt.activate()).pipe(Effect.ignore);
    yield* waitUntil(() => !!claudeIdeEnv().CLAUDE_CODE_SSE_PORT, '10 seconds');
  }
});

const exists = (f: string) => Effect.tryPromise(() => fs.promises.stat(f)).pipe(Effect.as(true), Effect.orElseSucceed(() => false));

// First existing match of `p` (absolute, ~/..., or relative to one of `dirs`), or null.
const resolvePath = (p: string, dirs: string[]) => Effect.gen(function* () {
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  for (const f of path.isAbsolute(p) ? [p] : dirs.map((d) => path.resolve(d, p))) {
    if (yield* exists(f)) return f;
  }
  return null;
});

// Splits a scheme-less link like "(src/a.ts#L10-L20)" or "src/a.ts:10:5" into path, line and column.
const parseRelativeLink = (link: string): { path: string; line?: number; col?: number } => {
  let s: string;
  try { s = decodeURI(link); } catch { s = link; }
  const [, p, l1, c1, l2, c2] = s.replace(/^\(|\)$/g, '')
    .match(/^(.*?)(?:#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::(\d+))?)?$/)!;
  const line = l1 ?? l2, col = c1 ?? c2;
  return { path: p, line: line ? +line : undefined, col: col ? +col : undefined };
};

const openTarget = (op: OpenPath) => Effect.gen(function* () {
  if ('url' in op) return yield* thenable(() => vscode.env.openExternal(vscode.Uri.parse(op.url)));
  if ('search' in op) return yield* thenable(() => vscode.commands.executeCommand('workbench.action.quickOpen', op.search));
  const u = vscode.Uri.file(op.path);
  if ((yield* Effect.tryPromise(() => fs.promises.stat(op.path))).isDirectory()) {
    return yield* thenable(() => vscode.commands.executeCommand('revealInExplorer', u));
  }
  const line = Math.max(0, (op.line || 1) - 1), col = Math.max(0, (op.col || 1) - 1);
  return yield* thenable(() => vscode.window.showTextDocument(u, op.line ? { selection: new vscode.Range(line, col, line, col) } : {}));
});

// A clicked OSC 8 / plain-text link.
const openLink = (link: string, dirs: string[]) => Effect.gen(function* () {
  // OSC 8 links without a scheme (e.g. Claude Code's markdown links) are relative paths.
  if (!/^[a-z][\w+.-]*:/i.test(link)) {
    const { path: p, line, col } = parseRelativeLink(link);
    const resolved = yield* resolvePath(p, dirs);
    return yield* openTarget(resolved ? { path: resolved, line, col } : { search: p });
  }
  // file:// links (e.g. paths printed by pi) open in the editor; everything else externally.
  const u = yield* Effect.try(() => vscode.Uri.parse(link, true));
  return yield* thenable(() => u.scheme === 'file' ? vscode.commands.executeCommand('vscode.open', u) : vscode.env.openExternal(u));
});

interface Shell {
  readonly pid: number | undefined;
  input(data: string): void;
  resize(cols: number, rows: number): void;
}

// The shell running under ptyhost.py, killed when the Scope closes. After it exits, the next keypress starts a fresh one.
const makeShell = (script: string, cwd: string, startupCmd: string, output: (data: string | Buffer) => void) => Effect.gen(function* () {
  let proc: PtyProc | undefined; // undefined while exited
  let size: string | undefined; // last "cols rows\n" from the webview; unknown until it first reports
  let keypress = Deferred.makeUnsafe<void>();
  const sized = yield* Deferred.make<void>();

  const writeSize = (p: PtyProc) => (p.stdio[3] as Writable).write(size);
  const spawn = Effect.acquireRelease(
    Effect.sync(() => cp.spawn('python3', [script], {
      cwd,
      env: { ...process.env, ...claudeIdeEnv(), TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' },
      stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
    }) as PtyProc),
    (p) => Effect.sync(() => p.kill()),
  );
  const runOnce = Effect.scoped(Effect.gen(function* () {
    const p = yield* spawn;
    const exited = yield* Deferred.make<void>();
    p.on('exit', () => Deferred.doneUnsafe(exited, Exit.void));
    p.stdout.on('data', output);
    proc = p;
    // Resize before the startup command so it starts at the right size.
    yield* Deferred.await(sized);
    writeSize(p);
    if (startupCmd) p.stdin.write(startupCmd + '\r');
    yield* Deferred.await(exited);
    proc = undefined;
    output('\r\n\x1b[2m[process exited — press any key to restart]\x1b[0m\r\n');
  }));
  yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    keypress = Deferred.makeUnsafe<void>();
    yield* runOnce;
    yield* Deferred.await(keypress);
    output('\x1bc'); // reset screen
  })));

  return {
    get pid() { return proc?.pid; },
    input: (data) => proc ? proc.stdin.write(data) : Deferred.doneUnsafe(keypress, Exit.void),
    resize: (cols, rows) => {
      const first = !size;
      size = `${cols} ${rows}\n`;
      if (first) Deferred.doneUnsafe(sized, Exit.void);
      else if (proc) writeSize(proc);
    },
  } satisfies Shell;
});

// The live sidebar terminal, if its view is open.
let sidebar: { view: vscode.WebviewView; shell: Shell } | undefined;

// Claude Code's extension calls activeTerminal.show() when a prompt is submitted (closeAllDiffTabs) or a diff
// opens, to refocus the terminal it assumes the CLI runs in — popping open a hidden panel. Terminal objects are
// shared by every extension in this extension host, so wrap show(): when Claude runs in the sidebar and not in
// that terminal, focus the sidebar instead. Claude launching its own new terminal (not yet active) is untouched.
// ponytail: stack-sniffs another extension's calls; breaks quietly (back to the popup) if VS Code or Claude Code change.
const redirectClaudeTerminalFocus = (t: vscode.Terminal): void => {
  const show = t.show;
  t.show = (preserveFocus?: boolean) => {
    if (!new Error().stack?.includes('anthropic.claude-code') || t !== vscode.window.activeTerminal) return show.call(t, preserveFocus);
    void t.processId.then((pid) => {
      if (!sidebar || !runsClaude(sidebar.shell.pid) || runsClaude(pid)) show.call(t, preserveFocus);
      else if (!preserveFocus) sidebar.view.show(false);
    });
  };
};

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

const resolveWebviewView = (ctx: vscode.ExtensionContext, view: vscode.WebviewView) => Effect.gen(function* () {
  yield* waitForIdeEnv;

  const xtermRoot = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@xterm');
  view.webview.options = { enableScripts: true, localResourceRoots: [xtermRoot] };

  const cwd = workspaceDirs()[0] || os.homedir();
  const startupCmd = vscode.workspace.getConfiguration('sidebarTerminal').get<string>('startupCommand', '').trim();
  const shell = yield* makeShell(path.join(ctx.extensionPath, 'ptyhost.py'), cwd, startupCmd,
    (data) => view.webview.postMessage(Buffer.from(data).toString('base64')));
  yield* Effect.acquireRelease(Effect.sync(() => { sidebar = { view, shell }; }), () => Effect.sync(() => { sidebar = undefined; }));

  // Opening the sidebar should put the cursor in the terminal (the webview then forwards focus to xterm).
  yield* disposable(() => view.onDidChangeVisibility(() => { if (view.visible) view.show(false); }));

  // Where relative paths in terminal output may live: the shell's (and its children's) cwds, then the workspace.
  const searchDirs = () => [...processCwds(shell.pid), cwd, ...workspaceDirs()];

  const handle = (m: WebviewMsg): Effect.Effect<unknown, unknown> => {
    if (m.copy !== undefined) return thenable(() => vscode.env.clipboard.writeText(m.copy!));
    if (m.paste) return thenable(() => vscode.env.clipboard.readText()).pipe(
      Effect.andThen((paste) => thenable(() => view.webview.postMessage({ paste }))));
    if (m.input !== undefined) return Effect.sync(() => shell.input(m.input!));
    if (m.openPath) return openTarget(m.openPath);
    if (m.open) return openLink(m.open, searchDirs());
    if (m.resolve) {
      const dirs = searchDirs();
      return Effect.forEach(m.resolve, (p) => resolvePath(p, dirs), { concurrency: 'unbounded' }).pipe(
        Effect.andThen((results) => thenable(() => view.webview.postMessage({ resolved: m.id, results }))));
    }
    return Effect.sync(() => { if (m.cols && m.rows) shell.resize(m.cols, m.rows); });
  };
  const run = yield* FiberSet.makeRuntime<never>();
  yield* disposable(() => view.webview.onDidReceiveMessage((m: WebviewMsg) =>
    run(handle(m).pipe(Effect.catchCause((cause) => Effect.logError('sidebarTerminal', cause))))));

  view.webview.html = webviewHtml(view.webview, ctx.extensionPath, xtermRoot);
});

// Everything the extension holds open; closed on deactivate.
let root: Scope.Closeable | undefined;

export const deactivate = (): Promise<void> | undefined => root && Effect.runPromise(Scope.close(root, Exit.void));

export const activate = (ctx: vscode.ExtensionContext): void => {
  const scope = root = Scope.makeUnsafe();
  Effect.runFork(piContext.activate(ctx).pipe(Scope.provide(scope)));
  vscode.window.terminals.forEach(redirectClaudeTerminalFocus);
  Effect.runSync(Effect.all([
    disposable(() => vscode.window.onDidOpenTerminal(redirectClaudeTerminalFocus)),
    disposable(() => vscode.window.registerWebviewViewProvider('sidebarTerminal.view', {
      // Each view gets its own scope, closed when the view is disposed.
      resolveWebviewView: (view) => {
        const viewScope = Scope.forkUnsafe(scope);
        view.onDidDispose(() => Effect.runFork(Scope.close(viewScope, Exit.void)));
        return Effect.runPromise(resolveWebviewView(ctx, view).pipe(Scope.provide(viewScope)));
      },
    }, { webviewOptions: { retainContextWhenHidden: true } })),
  ]).pipe(Scope.provide(scope)));
};
