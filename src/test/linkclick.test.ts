// npm test — Ctrl/Cmd-link clicks must not also reach the application's mouse handler.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// Exercise the actual compiled webview code.
const source = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminal.js'), 'utf8');
const fragment = source.slice(source.indexOf('// Reserve Ctrl/Cmd-left-click'), source.indexOf('// OSC 52 clipboard writes'));
assert.ok(fragment.includes('term.onData'));
const down: ((e: { button: number; ctrlKey: boolean; metaKey: boolean }) => void)[] = [];
const up: (() => void)[] = [], microtasks: (() => void)[] = [], sent: string[] = [];
let input!: (text: string) => void;
vm.runInNewContext(fragment, {
  term: {
    element: { addEventListener: (name: string, fn: typeof down[number], capture: boolean) => {
      assert.strictEqual(name, 'mousedown'); assert.strictEqual(capture, true); down.push(fn);
    } },
    onData: (fn: typeof input) => { input = fn; },
  },
  document: { addEventListener: (name: string, fn: () => void, capture: boolean) => {
    assert.strictEqual(name, 'mouseup'); assert.strictEqual(capture, true); up.push(fn);
  } },
  queueMicrotask: (fn: () => void) => microtasks.push(fn),
  vscode: { postMessage: (m: { input: string }) => sent.push(m.input) },
});
const press = (ctrlKey = false, metaKey = false, button = 0) => down.forEach(fn => fn({ ctrlKey, metaKey, button }));
const release = (packet: string) => {
  up.forEach(fn => fn()); input(packet); // Capture listener runs before xterm's bubbling mouse listener.
  microtasks.splice(0).forEach(fn => fn());
};
const mouseDown = '\x1b[<16;10;20M', mouseUp = '\x1b[<16;10;20m';
press(true); input(mouseDown); input('typed key'); release(mouseUp);
assert.deepStrictEqual(sent, ['typed key']);
input('\x1b[<0;10;20M'); // Reset after release.
press(false); input('\x1b[<0;10;20M'); release('\x1b[<0;10;20m');
assert.strictEqual(sent.length, 4); // Ordinary mouse input is unaffected.
press(false, true); input('\x1b[<0;10;20M'); release('\x1b[<0;10;20m');
assert.strictEqual(sent.length, 4); // Cmd-click, even though meta isn't encoded in mouse packets.
press(true); input('\x1b[M0*4'); input('\x1b[48;10;20M'); release(mouseUp);
assert.strictEqual(sent.length, 4); // X10 and urxvt mouse encodings.
press(true, false, 2); input('\x1b[<18;10;20M'); release('\x1b[<18;10;20m');
assert.strictEqual(sent.length, 6); // Right-click isn't reserved for links.
press(true); input('\x1b[I'); assert.strictEqual(sent.length, 6); release(mouseUp);
assert.strictEqual(sent[6], '\x1b[I'); // Focus report held until the link click ends, then sent.
console.log('OK: Ctrl/Cmd-link clicks stay in webview; keyboard and ordinary mouse input pass through');
