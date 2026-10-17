// Pi editor-context bridge (VSCode side of ~/.pi/agent/extensions/pi-vscode-context.ts).
// Serves editor context over a loopback socket (NDJSON); port exported to
// integrated terminals as PI_VSCODE_PORT.
//
// Key behaviour: when focus moves to a non-text tab (e.g. pi running in a
// terminal tab in the editor area), activeTextEditor becomes undefined. We keep
// the last file editor's snapshot instead of reporting "no selection", and only
// drop it once that file's tab is closed.
import * as vscode from "vscode";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Effect, FiberHandle, FiberSet } from "effect";
import { disposable, thenable } from "./scoped";

interface SelectionInfo {
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

interface Snapshot {
  fsPath: string;
  path: string;
  languageId: string;
  cursorLine: number;
  selections: SelectionInfo[];
}

interface OpenFile {
  path: string;
  active: boolean;
  languageId: string;
  dirty: boolean;
}

export interface EditorContext {
  workspace: string | null;
  timestamp: string;
  activeFile: string | null;
  openFiles: OpenFile[];
  selection: Omit<Snapshot, "fsPath"> | null;
}

type OutMsg = { type: "context"; data: EditorContext } | { type: "inject"; text: string };

interface OpenMsg {
  type: "open";
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
}

// Fallback for terminals that ignore environmentVariableCollection
// (e.g. Secondary Terminal): advertise the port in a file pi can discover.
const PORT_DIR = path.join(os.homedir(), ".pi", "agent", "vscode-ports");
const portFile = (p: number) =>
  Effect.acquireRelease(
    Effect.try(() => {
      const file = path.join(PORT_DIR, `${p}.json`);
      fs.mkdirSync(PORT_DIR, { recursive: true });
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      fs.writeFileSync(file, JSON.stringify({ port: p, folders, ts: Date.now() }));
      return file;
    }),
    (file) => Effect.sync(() => fs.rmSync(file, { force: true })),
  );

const PORT_KEY = "piContext.port";
const MAX_LINES = 400;
const sockets = new Set<net.Socket>();
let last: Snapshot | null = null;

const root = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const rel = (p: string): string => {
  const r = root();
  return r && p.startsWith(r + path.sep) ? path.relative(r, p) : p;
};

function snapshot(editor: vscode.TextEditor): Snapshot {
  const doc = editor.document;
  return {
    fsPath: doc.uri.fsPath,
    path: rel(doc.uri.fsPath),
    languageId: doc.languageId,
    cursorLine: editor.selection.active.line + 1,
    selections: editor.selections
      .filter((s) => !s.isEmpty)
      .map((s) => {
        const startLine = s.start.line + 1;
        const endLine = s.end.line + 1;
        const truncated = endLine - startLine + 1 > MAX_LINES;
        const range = truncated ? new vscode.Range(s.start.line, 0, s.start.line + MAX_LINES, 0) : s;
        return { startLine, endLine, text: doc.getText(range), truncated };
      }),
  };
}

// User settings use vscode-userdata: even though fsPath points to a local file.
const isLocalFile = (uri: vscode.Uri): boolean => uri.scheme === "file" || uri.scheme === "vscode-userdata";

function collect(): EditorContext {
  const e = vscode.window.activeTextEditor;
  if (e && isLocalFile(e.document.uri)) last = snapshot(e);

  const openFiles: OpenFile[] = [];
  const seen = new Set<string>();
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
    if (!uri || !isLocalFile(uri) || seen.has(uri.fsPath)) continue;
    seen.add(uri.fsPath);
    openFiles.push({
      path: rel(uri.fsPath),
      active: uri.fsPath === last?.fsPath,
      languageId: path.extname(uri.fsPath).slice(1),
      dirty: tab.isDirty,
    });
  }
  // Remembered file was closed -> forget it.
  if (last && !seen.has(last.fsPath)) last = null;

  let selection: EditorContext["selection"] = null;
  if (last) {
    const { fsPath: _fsPath, ...rest } = last;
    selection = rest;
  }
  return {
    workspace: root() ?? null,
    timestamp: new Date().toISOString(),
    activeFile: last?.path ?? null,
    openFiles,
    selection,
  };
}

const send = (s: net.Socket, msg: OutMsg): void => {
  if (s.writable) s.write(JSON.stringify(msg) + "\n");
};
const broadcast = (msg: OutMsg): void => sockets.forEach((s) => send(s, msg));
const push = Effect.sync(() => broadcast({ type: "context", data: collect() }));

const open = (msg: OpenMsg) =>
  Effect.gen(function* () {
    const abs = path.isAbsolute(msg.path) ? msg.path : path.join(root() ?? process.cwd(), msg.path);
    const doc = yield* thenable(() => vscode.workspace.openTextDocument(abs));
    // Don't steal the pi terminal's tab: open beside it if the active tab isn't a text editor.
    const viewColumn = vscode.window.activeTextEditor ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    const editor = yield* thenable(() => vscode.window.showTextDocument(doc, { viewColumn, preserveFocus: true }));
    if (msg.line) {
      const start = Math.min(Math.max(0, msg.line - 1), doc.lineCount - 1);
      const end = Math.min(Math.max(start, (msg.endLine ?? msg.line) - 1), doc.lineCount - 1);
      const range = new vscode.Range(start, Math.max(0, (msg.column ?? 1) - 1), end, doc.lineAt(end).range.end.character);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }).pipe(Effect.catchCause((cause) => Effect.logError("piContext: open failed", cause)));

function sendToPi(): void {
  const ctx = collect();
  const sel = ctx.selection;
  const text = sel?.selections.length
    ? sel.selections.map((s) => `@${sel.path}#L${s.startLine}${s.endLine > s.startLine ? `-${s.endLine}` : ""}`).join(" ")
    : ctx.activeFile && `@${ctx.activeFile}`;
  if (!sockets.size) {
    vscode.window.showWarningMessage("No pi session connected. Run `pi` in a VSCode terminal.");
    return;
  }
  if (!text) {
    vscode.window.showWarningMessage("No file or selection to send.");
    return;
  }
  broadcast({ type: "inject", text });
}

// Resolves with the bound port once listening; the server closes with the Scope.
const serve = (port: number, onConnection: (sock: net.Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<net.Server, NodeJS.ErrnoException>((resume) => {
      const srv = net.createServer(onConnection);
      srv.on("error", (err) => resume(Effect.fail(err)));
      srv.listen(port, "127.0.0.1", () => resume(Effect.succeed(srv)));
    }),
    (srv) => Effect.sync(() => srv.close()),
  ).pipe(Effect.map((srv) => (srv.address() as net.AddressInfo).port));

const onConnection = (run: (e: Effect.Effect<void>) => unknown) => (sock: net.Socket): void => {
  sockets.add(sock);
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.type === "open") run(open(msg as OpenMsg));
      } catch {}
    }
  });
  sock.on("close", () => sockets.delete(sock));
  sock.on("error", () => sockets.delete(sock));
  send(sock, { type: "context", data: collect() });
};

export const activate = (context: vscode.ExtensionContext) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    // Each call interrupts the pending one: a 200ms debounce.
    const runDebounced = yield* FiberHandle.makeRuntime<never>();
    const schedule = (): void => void runDebounced(Effect.sleep("200 millis").pipe(Effect.andThen(push)));
    yield* Effect.forEach([
      () => vscode.commands.registerCommand("piContext.sendToPi", sendToPi),
      () => vscode.window.onDidChangeActiveTextEditor(schedule),
      () => vscode.window.onDidChangeTextEditorSelection(schedule),
      () => vscode.window.tabGroups.onDidChangeTabs(schedule),
      () => vscode.workspace.onDidSaveTextDocument(schedule),
    ], disposable);
    collect();
    yield* Effect.addFinalizer(() => Effect.sync(() => sockets.forEach((s) => s.destroy())));

    // Reuse the previous port so pi sessions survive a window reload; fall back to ephemeral.
    const saved = context.workspaceState.get<number>(PORT_KEY);
    const p = yield* serve(saved || 0, onConnection(run)).pipe(
      Effect.catchIf((err) => !!saved && err.code === "EADDRINUSE", () => serve(0, onConnection(run))),
    );
    yield* thenable(() => context.workspaceState.update(PORT_KEY, p)).pipe(Effect.ignore);
    context.environmentVariableCollection.replace("PI_VSCODE_PORT", String(p));
    // Terminals spawned by other extensions in this extension host (e.g. Secondary
    // Terminal, which spreads process.env) inherit this.
    process.env.PI_VSCODE_PORT = String(p);
    yield* portFile(p).pipe(Effect.catchCause((cause) => Effect.logError("piContext portfile", cause)));
  }).pipe(Effect.catchCause((cause) => Effect.logError("piContext", cause)));
