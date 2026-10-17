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
  const HTTP_URL = /https?:\/\/[^\s"'`<>]+/g;
  const SUFFIX = /^(.*?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)?$/; // path:line:col | path#L10-L20
  const TLDS = 'com|org|net|io|ai|dev|app|co|gov|edu|me|sh|so|gg|xyz|info|tech|cloud|page|site';
  const DOMAIN = new RegExp(`^(?:[a-z0-9-]+\\.)+(?:[a-z]{2,}(?=/)|(?:${TLDS})$)`, 'i');
  const MAX_ROWS = 4; // how far a path or URL may span

  interface Cell { x: number; y: number } // 0-based column, 1-based buffer row (as xterm's link ranges use)
  interface Span { start: number; end: number } // string indices into Joined.text, end exclusive
  interface Candidate extends Span { path: string; line?: number; col?: number }

  // ---- Reading the buffer ----

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

  // Rows around y joined into one string, with each char's cell. Soft wraps (the terminal's own) join as-is.
  // With hard=true, rows also join across real newlines (TUIs like Claude Code wrap long paths themselves),
  // dropping trailing padding and the next row's indent. `seams` are the string indices of those hard joins.
  interface Joined { text: string; pos: Cell[]; seams: number[] }
  const joinRows = (y: number, hard: boolean): Joined | null => {
    const row = readRow(y);
    if (!row) return null;
    const joins = (above: Row, below: Row) =>
      below.wrapped || (hard && /\S$/.test(above.text.trimEnd()) && /^\s*\S/.test(below.text));

    const rows: { y: number; row: Row }[] = [{ y, row }];
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
      const hardJoinAbove = i > 0 && !r.wrapped;
      const hardJoinBelow = i < rows.length - 1 && !rows[i + 1].row.wrapped;
      const from = hardJoinAbove ? r.text.length - r.text.trimStart().length : 0;
      const to = hardJoinBelow ? r.text.trimEnd().length : r.text.length;
      if (hardJoinAbove) out.seams.push(out.text.length);
      out.text += r.text.slice(from, to);
      for (let j = from; j < to; j++) out.pos.push({ x: r.col[j], y });
    });
    return out;
  };

  const touchesRow = (j: Joined, s: Span, y: number) => j.pos[s.start].y <= y && j.pos[s.end - 1].y >= y;
  const seamsInside = (j: Joined, s: Span) => j.seams.filter((seam) => s.start < seam && seam < s.end);

  // ---- Finding candidates ----

  // Path-like tokens, with any :line:col / #L10 suffix split off.
  const pathCandidates = (text: string): Candidate[] => {
    const out: Candidate[] = [];
    for (const m of text.matchAll(TOKEN)) {
      let s = m[0], start = m.index!;
      if (s.includes('://')) continue; // URLs are handled by the web-links addon / OSC 8
      const lead = s.match(/^[*_~.:]*(?=[~.\/\w])/)?.[0] ?? ''; // markdown/punctuation before the path
      if (lead && !/^\.{1,2}\/|^~\//.test(s)) { s = s.slice(lead.length); start += lead.length; }
      s = s.replace(/:(?!\d).*$/, '').replace(/[.,:;!?*_]+$/, ''); // "file.js:12:code" -> "file.js:12"
      if (!/^[~.\/\w@]/.test(s) || /[=\\*$]/.test(s)) continue; // flags, globs, regexes, shell vars
      const [, path, line1, col1, line2, col2] = s.match(SUFFIX)!;
      if (!path || !/[A-Za-z]/.test(path)) continue;
      if (!path.includes('/') && !/\.[A-Za-z][\w-]{0,9}$/.test(path)) continue; // bare words need an extension
      const line = line1 ?? line2, col = col1 ?? col2;
      out.push({ start, end: start + s.length, path, line: line ? +line : undefined, col: col ? +col : undefined });
    }
    return out;
  };

  // URLs a TUI hard-wrapped (the web-links addon only follows soft wraps). Only joined where the row before
  // the break reaches the right edge, so a URL ending a line doesn't swallow the next line's text.
  // ponytail: right-edge heuristic, misses TUIs that wrap well short of the terminal width.
  const wrappedUrls = (j: Joined, y: number): Span[] =>
    [...j.text.matchAll(HTTP_URL)]
      .map((m) => ({ start: m.index!, end: m.index! + m[0].replace(/[.,;:!?'")\]]+$/, '').length }))
      .filter((s) => touchesRow(j, s, y) && seamsInside(j, s).some((seam) => j.pos[seam - 1].x >= term.cols - 3));

  // ---- Resolving (cached briefly, since xterm asks again on every hover) ----

  const cache = new Map<string, { t: number; value: Promise<string | null> }>();
  const lookup = (cands: Candidate[]): Promise<(string | null)[]> => {
    const now = Date.now();
    const missing = cands.filter((c) => { const hit = cache.get(c.path); return !hit || now - hit.t > 5000; });
    if (missing.length) {
      const res = resolve(missing.map((c) => c.path));
      missing.forEach((c, i) => cache.set(c.path, { t: now, value: res.then((r) => r[i], () => null) }));
    }
    return Promise.all(cands.map((c) => cache.get(c.path)!.value));
  };

  // ---- Providing links for row y ----

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const soft = joinRows(y, false), hard = joinRows(y, true);
      if (!soft || !hard) return callback(undefined);

      // Paths within soft-wrapped text are certain enough to link even if they don't resolve (-> Quick Open).
      const safe = pathCandidates(soft.text).filter((c) => touchesRow(soft, c, y));
      // Paths that cross a hard newline are guesses: only linked if they resolve to a file.
      const wrapped = hard.seams.length > 0;
      const guesses = wrapped ? pathCandidates(hard.text).filter((c) => touchesRow(hard, c, y) && seamsInside(hard, c).length) : [];
      const urls = wrapped ? wrappedUrls(hard, y) : [];
      if (!safe.length && !guesses.length && !urls.length) return callback(undefined);

      Promise.all([lookup(safe), lookup(guesses)]).then(([safeResolved, guessResolved]) => {
        const links: XLink[] = [];
        const taken: { start: Cell; end: Cell }[] = []; // cells covered by multi-row links
        const add = (j: Joined, s: Span, target: PathLinkTarget, multiRow = false) => {
          const start = j.pos[s.start], end = j.pos[s.end - 1];
          if (multiRow) taken.push({ start, end });
          links.push({
            range: { start: { x: start.x + 1, y: start.y }, end: { x: end.x + 1, y: end.y } },
            text: j.text.slice(s.start, s.end),
            activate: (ev) => { if (ev.ctrlKey || ev.metaKey) open(target); },
          });
        };
        const before = (a: Cell, b: Cell) => a.y < b.y || (a.y === b.y && a.x < b.x);
        const overlapsTaken = (start: Cell, end: Cell) => taken.some((t) => !before(end, t.start) && !before(t.end, start));

        urls.forEach((s) => add(hard, s, { url: hard.text.slice(s.start, s.end) }, true));
        guesses.forEach((c, i) => {
          const path = guessResolved[i];
          if (path) add(hard, c, { path, line: c.line, col: c.col }, true);
        });
        safe.forEach((c, i) => {
          if (overlapsTaken(soft.pos[c.start], soft.pos[c.end - 1])) return;
          const path = safeResolved[i], text = soft.text.slice(c.start, c.end);
          add(soft, c, path ? { path, line: c.line, col: c.col }
            : DOMAIN.test(c.path) ? { url: 'https://' + text }
            : { search: text });
        });
        callback(links.length ? links : undefined);
      });
    },
  });
};
