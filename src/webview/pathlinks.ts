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
  const SUFFIX = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)?$/; // path:line:col | path#L10-L20
  const TLDS = 'com|org|net|io|ai|dev|app|co|gov|edu|me|sh|so|gg|xyz|info|tech|cloud|page|site';
  const DOMAIN = new RegExp(`^(?:[a-z0-9-]+\\.)+(?:[a-z]{2,}(?=/)|(?:${TLDS})$)`, 'i');
  const cache = new Map<string, { t: number; value: Promise<string | null> }>();

  interface Candidate { start: number; end: number; path: string; line?: number; col?: number }

  // Row text plus a map from string index to (0-based) cell column, so wide chars don't shift ranges.
  interface Row { text: string; col: number[]; wrapped: boolean }
  const readRow = (y: number): Row | null => {
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
    return { text, col, wrapped: line.isWrapped };
  };

  // Rows around y joined into one string, with each char's cell position. Soft wraps (the terminal's own)
  // join as-is; with hard=true, rows also join across real newlines (TUIs like Claude Code wrap long paths
  // themselves), dropping trailing padding and the next row's indent. `seams` are the string indices of hard joins.
  interface Joined { text: string; pos: { x: number; y: number }[]; seams: number[] }
  const MAX_ROWS = 4;
  const joinRows = (y: number, hard: boolean): Joined | null => {
    const row = readRow(y);
    if (!row) return null;
    const rows: { y: number; row: Row }[] = [{ y, row }];
    const joins = (above: Row, below: Row) => below.wrapped || (hard && /\S$/.test(above.text.trimEnd()) && /^\s*\S/.test(below.text));
    for (let i = 1, top = row; i < MAX_ROWS; i++) {
      const r = readRow(y - i);
      if (!r || !joins(r, top)) break;
      rows.unshift({ y: y - i, row: (top = r) });
    }
    for (let i = 1, bottom = row; i < MAX_ROWS; i++) {
      const r = readRow(y + i);
      if (!r || !joins(bottom, r)) break;
      rows.push({ y: y + i, row: (bottom = r) });
    }
    const out: Joined = { text: '', pos: [], seams: [] };
    rows.forEach(({ y, row: r }, i) => {
      let from = 0, to = r.text.length;
      if (i > 0 && !r.wrapped) { from = r.text.length - r.text.trimStart().length; out.seams.push(out.text.length); }
      if (i < rows.length - 1 && !rows[i + 1].row.wrapped) to = r.text.trimEnd().length;
      out.text += r.text.slice(from, to);
      for (let j = from; j < to; j++) out.pos.push({ x: r.col[j], y });
    });
    return out;
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
      const [, p, line1, col1, line2, col2] = s.match(SUFFIX)!;
      const line = line1 ?? line2, col = col1 ?? col2;
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
      const soft = joinRows(y, false), hard = joinRows(y, true);
      if (!soft || !hard) return callback(undefined);
      const onRow = (j: Joined, c: Candidate) => j.pos[c.start].y <= y && j.pos[c.end - 1].y >= y;
      const safe = candidates(soft.text).filter((c) => onRow(soft, c));
      // Candidates that cross a hard newline are guesses: only linked if they resolve to a file.
      const guesses = hard.seams.length
        ? candidates(hard.text).filter((c) => onRow(hard, c) && hard.seams.some((s) => c.start < s && s < c.end))
        : [];
      if (!safe.length && !guesses.length) return callback(undefined);
      Promise.all([lookup(safe), lookup(guesses)]).then(([safeRes, guessRes]) => {
        const links: XLink[] = [];
        const add = (j: Joined, c: Candidate, target: PathLinkTarget) => {
          const s = j.pos[c.start], e = j.pos[c.end - 1];
          links.push({
            range: { start: { x: s.x + 1, y: s.y }, end: { x: e.x + 1, y: e.y } },
            text: j.text.slice(c.start, c.end),
            activate: (ev) => { if (ev.ctrlKey || ev.metaKey) open(target); },
          });
        };
        const taken: { s: { x: number; y: number }; e: { x: number; y: number } }[] = [];
        const before = (a: { x: number; y: number }, b: { x: number; y: number }) => a.y < b.y || (a.y === b.y && a.x < b.x);
        guesses.forEach((c, i) => {
          const r = guessRes[i];
          if (!r) return;
          add(hard, c, { path: r, line: c.line, col: c.col });
          taken.push({ s: hard.pos[c.start], e: hard.pos[c.end - 1] });
        });
        safe.forEach((c, i) => {
          const s = soft.pos[c.start], e = soft.pos[c.end - 1];
          if (taken.some((t) => !before(e, t.s) && !before(t.e, s))) return; // overlaps a resolved multi-row path
          const text = soft.text.slice(c.start, c.end);
          const r = safeRes[i];
          add(soft, c, r ? { path: r, line: c.line, col: c.col }
            : DOMAIN.test(c.path) ? { url: 'https://' + text }
            : { search: text });
        });
        callback(links.length ? links : undefined);
      });
    },
  });
};
