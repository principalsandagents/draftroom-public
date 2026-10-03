// Find a model's quoted span in the draft. Exact first, then whitespace- and
// quote-normalised, then fuzzy (diff-match-patch). Returns null when the quote
// is not there, which is how invented anchors get dropped.

import DiffMatchPatch from "diff-match-patch";

export interface Located {
  start: number;
  end: number;
  score: number; // 1 = exact
  method: "exact" | "normalised" | "fuzzy";
}

export const FUZZY_THRESHOLD = 0.85;
export const STALE_THRESHOLD = 0.95;

const dmp = new DiffMatchPatch();

const CHAR_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"',
  "–": "-", "—": "-", " ": " ", "…": ".",
};

/** Normalise text and keep a map from each normalised index back to the original index. */
function normalise(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < s.length; i++) {
    let c = CHAR_MAP[s[i]] ?? s[i];
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      c = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    norm += c.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const diffs = dmp.diff_main(a, b);
  const lev = dmp.diff_levenshtein(diffs);
  return 1 - lev / Math.max(a.length, b.length);
}

function contextScore(text: string, start: number, end: number, prefix: string, suffix: string): number {
  const p = prefix ? similarity(text.slice(Math.max(0, start - prefix.length), start), prefix) : 0.5;
  const s = suffix ? similarity(text.slice(end, end + suffix.length), suffix) : 0.5;
  return p + s;
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

export function locate(text: string, exact: string, prefix = "", suffix = "", hint?: number): Located | null {
  const q = exact.trim();
  if (q.length < 3) return null;

  // 1. Exact.
  const hits = allIndexes(text, q);
  if (hits.length) {
    const best = pickBest(text, hits, q.length, prefix, suffix, hint);
    return { start: best, end: best + q.length, score: 1, method: "exact" };
  }

  // 2. Normalised (curly quotes, dashes, whitespace, case).
  const T = normalise(text);
  const Q = normalise(q).norm.trim();
  const nhits = allIndexes(T.norm, Q);
  if (nhits.length) {
    const starts = nhits.map((n) => T.map[n]);
    const ends = nhits.map((n) => T.map[n + Q.length - 1] + 1);
    let bi = 0;
    if (starts.length > 1) {
      let bs = -1;
      starts.forEach((s, i) => {
        const sc = contextScore(text, s, ends[i], prefix, suffix) - (hint !== undefined ? Math.abs(s - hint) / 1e6 : 0);
        if (sc > bs) { bs = sc; bi = i; }
      });
    }
    return { start: starts[bi], end: ends[bi], score: 0.99, method: "normalised" };
  }

  // 3. Fuzzy: locate the head and tail of the quote, then score the span.
  return fuzzy(text, q, prefix, hint);
}

function pickBest(text: string, hits: number[], len: number, prefix: string, suffix: string, hint?: number): number {
  if (hits.length === 1) return hits[0];
  let best = hits[0];
  let bestScore = -Infinity;
  for (const h of hits) {
    const sc = contextScore(text, h, h + len, prefix, suffix) - (hint !== undefined ? Math.abs(h - hint) / 1e6 : 0);
    if (sc > bestScore) { bestScore = sc; best = h; }
  }
  return best;
}

function fuzzy(text: string, q: string, prefix: string, hint?: number): Located | null {
  const bits = 32;
  dmp.Match_Threshold = 0.3;
  dmp.Match_Distance = text.length; // allow anywhere
  const head = q.slice(0, bits);
  const tail = q.slice(-bits);
  const guess = hint ?? Math.max(0, text.indexOf(prefix.slice(-20)) + 20);
  const hs = dmp.match_main(text, head, Math.min(Math.max(0, guess), text.length));
  if (hs < 0) return null;
  const expectEnd = hs + q.length - tail.length;
  const te = dmp.match_main(text, tail, Math.min(Math.max(0, expectEnd), text.length));
  const end = te >= 0 && te > hs ? te + tail.length : hs + q.length;
  if (end - hs > q.length * 1.5) return null;
  const score = similarity(text.slice(hs, end), q);
  if (score < FUZZY_THRESHOLD) return null;
  return { start: hs, end: Math.min(end, text.length), score, method: "fuzzy" };
}

/** Re-anchor a stored comment against new text. Stale when it moved too far from the quote. */
export function reanchor(
  text: string,
  a: { exact: string; prefix: string; suffix: string; start: number },
): { start: number; end: number; stale: boolean } | null {
  const l = locate(text, a.exact, a.prefix, a.suffix, a.start);
  if (!l) return null;
  return { start: l.start, end: l.end, stale: l.score < STALE_THRESHOLD };
}

export function contextAround(text: string, start: number, end: number, n = 30): { prefix: string; suffix: string } {
  return { prefix: text.slice(Math.max(0, start - n), start), suffix: text.slice(end, end + n) };
}
