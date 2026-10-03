// npm test — checks selection survives focusing a terminal tab, and is dropped when the file closes.
import * as assert from "assert";
import type { EditorContext } from "../picontext";

const Module = require("module") as { _load: (req: string, ...a: unknown[]) => unknown };

const uri = { scheme: "file", fsPath: "/ws/a.py" };
const sel = { isEmpty: false, start: { line: 2 }, end: { line: 4 }, active: { line: 4 } };
const editor = { document: { uri, languageId: "python", getText: () => "x" }, selection: sel, selections: [sel] };
const tabs: object[] = [{ input: { uri }, isDirty: false }, { input: {} /* terminal */ }];
const vscode = {
  window: {
    activeTextEditor: editor as typeof editor | undefined,
    tabGroups: { all: [{ tabs }], onDidChangeTabs() {} },
    onDidChangeActiveTextEditor() {},
    onDidChangeTextEditorSelection() {},
  },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/ws" } }], onDidSaveTextDocument() {} },
  commands: { registerCommand() {} },
  Range: class {},
};
const load = Module._load;
Module._load = (req, ...a) => (req === "vscode" ? vscode : load(req, ...a));

let ctx!: EditorContext;
const fakeSock = { writable: true, write: (l: string) => (ctx = JSON.parse(l).data) };
let onConn!: (sock: unknown) => void;
const net = require("net") as { createServer: unknown };
net.createServer = (cb: typeof onConn) => ((onConn = cb), { on() {}, listen() {}, close() {} });
// Loaded after the mocks are installed (a static import would be hoisted above them).
const ext = require("../picontext") as typeof import("../picontext");
ext.activate({ workspaceState: { get() {}, update() {} }, environmentVariableCollection: { replace() {} }, subscriptions: [] } as never);
const connect = () => onConn({ ...fakeSock, setEncoding() {}, on() {} });

connect();
assert.deepStrictEqual([ctx.activeFile, ctx.selection!.selections[0].startLine], ["a.py", 3]);

vscode.window.activeTextEditor = undefined; // focus pi terminal tab
connect();
assert.strictEqual(ctx.activeFile, "a.py");
assert.strictEqual(ctx.selection!.selections[0].endLine, 5);
assert.strictEqual(ctx.openFiles[0].active, true);

tabs.shift(); // close a.py
connect();
assert.strictEqual(ctx.selection, null);
assert.strictEqual(ctx.activeFile, null);
console.log("ok");
