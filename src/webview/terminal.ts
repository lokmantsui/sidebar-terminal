// Runs in the webview: an xterm.js terminal wired to the extension host via postMessage.
//
// NOTE: like pathlinks.ts, this file must stay a global script (no top-level import/export) — it is
// inlined into the webview's <script> tag as-is, after xterm and its addons are loaded as globals.

declare const Terminal: typeof import('@xterm/xterm').Terminal;
declare const FitAddon: typeof import('@xterm/addon-fit');
declare const WebLinksAddon: typeof import('@xterm/addon-web-links');
declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();
const css = (v: string) => getComputedStyle(document.body).getPropertyValue(v).trim();
const decodeBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Like the integrated terminal: links open on Ctrl+click (Cmd+click on macOS).
const openLink = (e: MouseEvent, uri: string) => { if (e.ctrlKey || e.metaKey) vscode.postMessage({ open: uri }); };

const term = new Terminal({
  linkHandler: { activate: openLink, allowNonHttpProtocols: true }, // OSC 8 hyperlinks
  fontFamily: css('--vscode-editor-font-family') || 'monospace',
  fontSize: parseInt(css('--vscode-editor-font-size')) || 13,
  theme: { background: css('--vscode-sideBar-background'), foreground: css('--vscode-terminal-foreground') || css('--vscode-foreground') },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

// File paths in plain text (verified to exist by the extension host).
let reqId = 0;
const pending = new Map<number, (results: (string | null)[]) => void>();
try {
  window.installPathLinks(term,
    (paths) => new Promise((res) => { pending.set(++reqId, res); vscode.postMessage({ resolve: paths, id: reqId }); }),
    (openPath) => vscode.postMessage({ openPath }));
} catch (e) { console.error('path links disabled', e); }
// After path links: earlier providers win, so multi-row URLs beat the addon's partial first-row match.
term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink)); // plain-text URLs
term.open(document.getElementById('t')!);

// Reserve Ctrl/Cmd-left-click for webview links, not the application's own URL opener.
// Focus reports are held until the click ends: Claude Code answers focus-in with an OSC 104 color reset,
// which repaints every row, and xterm drops a link that is repainted between mousedown and mouseup.
let linkClick = false;
let heldFocusReports: string[] = [];
term.element!.addEventListener('mousedown', (e) => { linkClick = e.button === 0 && (e.ctrlKey || e.metaKey); }, true);
document.addEventListener('mouseup', () => {
  queueMicrotask(() => {
    linkClick = false;
    heldFocusReports.forEach((input) => vscode.postMessage({ input }));
    heldFocusReports = [];
  });
}, true);
term.onData((input) => {
  if (linkClick) {
    // xterm's mouse packets: SGR, urxvt and X10. Keyboard input must still pass through.
    if (/^\x1b\[(?:<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M|M[\s\S]{3})$/.test(input)) return;
    if (input === '\x1b[I' || input === '\x1b[O') { heldFocusReports.push(input); return; }
  }
  vscode.postMessage({ input });
});

// OSC 52 clipboard writes (pi copies its own mouse selections this way); reads ("?") are ignored.
term.parser.registerOscHandler(52, (data) => {
  const b64 = data.slice(data.indexOf(';') + 1);
  if (b64 !== '?') {
    try { vscode.postMessage({ copy: new TextDecoder().decode(decodeBase64(b64)) }); } catch {}
  }
  return true;
});

// Handle Cmd+C/V and Ctrl+Shift+C/V through VS Code's clipboard, including remote sessions.
term.attachCustomKeyEventHandler((e) => {
  const isCopyPaste = (e.metaKey || (e.ctrlKey && e.shiftKey)) && !e.altKey && (e.code === 'KeyC' || e.code === 'KeyV');
  if (!isCopyPaste) return true;
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

// From the extension host: path-resolve replies, clipboard text to paste, or base64 shell output.
window.addEventListener('message', (e) => {
  if (e.data.resolved !== undefined) {
    pending.get(e.data.resolved)?.(e.data.results);
    pending.delete(e.data.resolved);
  } else if (e.data.paste !== undefined) {
    term.paste(e.data.paste); // handles bracketed paste mode
  } else {
    term.write(decodeBase64(e.data));
  }
});

// VS Code focuses the webview's window, not xterm's textarea; forward it so typing goes to the terminal.
window.addEventListener('focus', () => term.focus());
if (document.hasFocus()) term.focus(); // focus may have arrived before this script ran
fit.fit();
vscode.postMessage({ cols: term.cols, rows: term.rows });
