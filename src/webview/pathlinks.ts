// Runs in the webview. Detects file paths in plain terminal text (like VS Code's integrated terminal does),
// asks the extension host which of them exist, and makes those Ctrl/Cmd+clickable.
// Like VS Code: bare domains (claude.ai/x) open as https URLs, and path-like text that doesn't resolve opens Quick Open.
// resolve(paths) -> Promise<(string|null)[]> (absolute path per candidate, or null);
// open(target) where target is { path, line, col } | { url } | { search }.
//
// NOTE: this file must stay a global script (no top-level import/export) — it is inlined into the
// webview's <script> tag as-is. Types are pulled in via import() type expressions instead.

type XTerminal = import('@xterm/xterm').Terminal;
type XLink = import('@xterm/xterm').ILink;

type PathLinkTarget = { path: string; line?: number; col?: number } | { url: string } | { search: string };

interface Window {
  installPathLinks(
    term: XTerminal,
    resolve: (paths: string[]) => Promise<(string | null)[]>,
    open: (target: PathLinkTarget) => void,
  ): void;
}

window.installPathLinks = (term, resolve, open) => {
  const TOKEN = /[^\s"'`<>()\[\]{}|,;]+/g;
  const SUFFIX = /^(.*?)(?::(\d+)(?::(\d+))?)?$/; // path:line:col
  const TLDS = 'com|org|net|io|ai|dev|app|co|gov|edu|me|sh|so|gg|xyz|info|tech|cloud|page|site';
  const DOMAIN = new RegExp(`^(?:[a-z0-9-]+\\.)+(?:[a-z]{2,}(?=/)|(?:${TLDS})$)`, 'i');
  const cache = new Map<string, { t: number; value: Promise<string | null> }>();

  interface Candidate { start: number; end: number; path: string; line?: number; col?: number }

  // Line text plus a map from string index to (0-based) cell column, so wide chars don't shift ranges.
  const readLine = (y: number): { text: string; col: number[] } | null => {
    const line = term.buffer.active.getLine(y - 1);
    if (!line) return null;
    let text = '';
    const col: number[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const ch = cell.getChars() || ' ';
      for (let i = 0; i < ch.length; i++) col.push(x);
      text += ch;
    }
    return { text, col };
  };

  const candidates = (text: string): Candidate[] => {
    const out: Candidate[] = [];
    for (const m of text.matchAll(TOKEN)) {
      let s = m[0], start = m.index!;
      if (s.includes('://')) continue; // URLs are handled by the web-links addon / OSC 8
      const lead = s.match(/^[*_~.:]*(?=[~.\/\w])/)?.[0] ?? ''; // markdown/punctuation before the path
      if (lead && !/^\.{1,2}\/|^~\//.test(s)) { s = s.slice(lead.length); start += lead.length; }
      s = s.replace(/:(?!\d).*$/, '').replace(/[.,:;!?*_]+$/, ''); // "file.js:12:code" -> "file.js:12"
      if (!/^[~.\/\w@]/.test(s) || /[=\\*$]/.test(s)) continue; // flags, globs, regexes, shell vars
      const [, p, line, col] = s.match(SUFFIX)!;
      if (!p || !/[A-Za-z]/.test(p)) continue;
      if (!p.includes('/') && !/\.[A-Za-z][\w-]{0,9}$/.test(p)) continue; // bare words need an extension
      out.push({ start, end: start + s.length, path: p, line: line ? +line : undefined, col: col ? +col : undefined });
    }
    return out;
  };

  const lookup = (cands: Candidate[]): Promise<(string | null)[]> => {
    const now = Date.now(), missing: Candidate[] = [];
    for (const c of cands) {
      const hit = cache.get(c.path);
      if (!hit || now - hit.t > 5000) missing.push(c);
    }
    if (missing.length) {
      const res = resolve(missing.map((c) => c.path));
      missing.forEach((c, i) => cache.set(c.path, { t: now, value: res.then((r) => r[i], () => null) }));
    }
    return Promise.all(cands.map((c) => cache.get(c.path)!.value));
  };

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const l = readLine(y);
      const cands = l ? candidates(l.text) : [];
      if (!l || !cands.length) return callback(undefined);
      lookup(cands).then((resolved) => {
        const links: XLink[] = [];
        cands.forEach((c, i) => {
          const text = l.text.slice(c.start, c.end);
          const r = resolved[i];
          const target: PathLinkTarget = r ? { path: r, line: c.line, col: c.col }
            : DOMAIN.test(c.path) ? { url: 'https://' + text }
            : { search: text };
          links.push({
            range: { start: { x: l.col[c.start] + 1, y }, end: { x: l.col[c.end - 1] + 1, y } },
            text,
            activate: (e) => { if (e.ctrlKey || e.metaKey) open(target); },
          });
        });
        callback(links.length ? links : undefined);
      });
    },
  });
};
