// node picontext.test.js — checks selection survives focusing a terminal tab, and is dropped when the file closes.
const assert = require("assert");
const Module = require("module");

const uri = { scheme: "file", fsPath: "/ws/a.py" };
const sel = { isEmpty: false, start: { line: 2 }, end: { line: 4 }, active: { line: 4 } };
const editor = { document: { uri, languageId: "python", getText: () => "x" }, selection: sel, selections: [sel] };
const tabs = [{ input: { uri }, isDirty: false }, { input: {} /* terminal */ }];
const vscode = {
  window: { activeTextEditor: editor, tabGroups: { all: [{ tabs }], onDidChangeTabs() {} }, onDidChangeActiveTextEditor() {}, onDidChangeTextEditorSelection() {} },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/ws" } }], onDidSaveTextDocument() {} },
  commands: { registerCommand() {} },
  Range: class {},
};
const load = Module._load;
Module._load = (req, ...a) => (req === "vscode" ? vscode : load(req, ...a));

let ctx;
const fakeSock = { writable: true, write: (l) => (ctx = JSON.parse(l).data) };
let onConn;
require("net").createServer = (cb) => ((onConn = cb), { on() {}, listen() {}, close() {} });
const ext = require("./picontext.js");
ext.activate({ workspaceState: { get() {}, update() {} }, environmentVariableCollection: { replace() {} }, subscriptions: [] });
const connect = () => onConn({ ...fakeSock, setEncoding() {}, on() {} });

connect();
assert.deepStrictEqual([ctx.activeFile, ctx.selection.selections[0].startLine], ["a.py", 3]);

vscode.window.activeTextEditor = undefined; // focus pi terminal tab
connect();
assert.strictEqual(ctx.activeFile, "a.py");
assert.strictEqual(ctx.selection.selections[0].endLine, 5);
assert.strictEqual(ctx.openFiles[0].active, true);

tabs.shift(); // close a.py
connect();
assert.strictEqual(ctx.selection, null);
assert.strictEqual(ctx.activeFile, null);
console.log("ok");
