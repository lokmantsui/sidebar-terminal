// Pi editor-context bridge (VSCode side of ~/.pi/agent/extensions/pi-vscode-context.ts).
// Serves editor context over a loopback socket (NDJSON); port exported to
// integrated terminals as PI_VSCODE_PORT.
//
// Key behaviour: when focus moves to a non-text tab (e.g. pi running in a
// terminal tab in the editor area), activeTextEditor becomes undefined. We keep
// the last file editor's snapshot instead of reporting "no selection", and only
// drop it once that file's tab is closed.
const vscode = require("vscode");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Fallback for terminals that ignore environmentVariableCollection
// (e.g. Secondary Terminal): advertise the port in a file pi can discover.
const PORT_DIR = path.join(os.homedir(), ".pi", "agent", "vscode-ports");
let portFile;
function writePortFile(p) {
  try {
    fs.mkdirSync(PORT_DIR, { recursive: true });
    if (portFile && portFile !== path.join(PORT_DIR, `${p}.json`)) fs.rmSync(portFile, { force: true });
    portFile = path.join(PORT_DIR, `${p}.json`);
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    fs.writeFileSync(portFile, JSON.stringify({ port: p, folders, ts: Date.now() }));
  } catch (e) {
    console.error("piContext portfile", e);
  }
}

const PORT_KEY = "piContext.port";
const MAX_LINES = 400;
const sockets = new Set();
let server;
let last = null; // { fsPath, path, languageId, cursorLine, selections }
let timer;

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const rel = (p) => {
  const r = root();
  return r && p.startsWith(r + path.sep) ? path.relative(r, p) : p;
};

function snapshot(editor) {
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

function collect() {
  const e = vscode.window.activeTextEditor;
  if (e && e.document.uri.scheme === "file") last = snapshot(e);

  const openFiles = [];
  const seen = new Set();
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    const uri = tab.input?.uri;
    if (!uri || uri.scheme !== "file" || seen.has(uri.fsPath)) continue;
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

  const { fsPath, ...selection } = last ?? {};
  return {
    workspace: root() ?? null,
    timestamp: new Date().toISOString(),
    activeFile: last?.path ?? null,
    openFiles,
    selection: last ? selection : null,
  };
}

const send = (s, msg) => s.writable && s.write(JSON.stringify(msg) + "\n");
const broadcast = (msg) => sockets.forEach((s) => send(s, msg));
const push = () => broadcast({ type: "context", data: collect() });
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(push, 200);
};

async function open(msg) {
  try {
    const abs = path.isAbsolute(msg.path) ? msg.path : path.join(root() ?? process.cwd(), msg.path);
    const doc = await vscode.workspace.openTextDocument(abs);
    // Don't steal the pi terminal's tab: open beside it if the active tab isn't a text editor.
    const viewColumn = vscode.window.activeTextEditor ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    const editor = await vscode.window.showTextDocument(doc, { viewColumn, preserveFocus: true });
    if (msg.line) {
      const start = Math.min(Math.max(0, msg.line - 1), doc.lineCount - 1);
      const end = Math.min(Math.max(start, (msg.endLine ?? msg.line) - 1), doc.lineCount - 1);
      const range = new vscode.Range(start, Math.max(0, (msg.column ?? 1) - 1), end, doc.lineAt(end).range.end.character);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  } catch (err) {
    console.error("piContext: open failed", err);
  }
}

function sendToPi() {
  const ctx = collect();
  const sel = ctx.selection;
  const text = sel?.selections.length
    ? sel.selections.map((s) => `@${sel.path}#L${s.startLine}${s.endLine > s.startLine ? `-${s.endLine}` : ""}`).join(" ")
    : ctx.activeFile && `@${ctx.activeFile}`;
  if (!sockets.size) return vscode.window.showWarningMessage("No pi session connected. Run `pi` in a VSCode terminal.");
  if (!text) return vscode.window.showWarningMessage("No file or selection to send.");
  broadcast({ type: "inject", text });
}

function listen(context, port) {
  server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === "open") open(msg);
        } catch {}
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sockets.delete(sock));
    send(sock, { type: "context", data: collect() });
  });
  // Reuse the previous port so pi sessions survive a window reload; fall back to ephemeral.
  server.on("error", (err) => (port && err.code === "EADDRINUSE" ? listen(context, 0) : console.error("piContext", err)));
  server.listen(port || 0, "127.0.0.1", () => {
    const p = server.address().port;
    context.workspaceState.update(PORT_KEY, p);
    context.environmentVariableCollection.replace("PI_VSCODE_PORT", String(p));
    // Terminals spawned by other extensions in this extension host (e.g. Secondary
    // Terminal, which spreads process.env) inherit this.
    process.env.PI_VSCODE_PORT = String(p);
    writePortFile(p);
  });
}

exports.activate = (context) => {
  listen(context, context.workspaceState.get(PORT_KEY));
  context.subscriptions.push(
    vscode.commands.registerCommand("piContext.sendToPi", sendToPi),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.tabGroups.onDidChangeTabs(schedule),
    vscode.workspace.onDidSaveTextDocument(schedule),
  );
  collect();
};

exports.deactivate = () => {
  sockets.forEach((s) => s.destroy());
  server?.close();
  if (portFile) try { fs.rmSync(portFile, { force: true }); } catch {}
};
