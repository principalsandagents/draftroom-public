// Quotes in the draft and exact matching against a source's text. No model.

import DiffMatchPatch from "diff-match-patch";
import { parseNotes } from "../../shared/notes.ts";
import { blocks, bodyStart } from "../../shared/doc.ts";

export interface FoundQuote {
  quote: string; // as written, without the quotation marks
  start: number; // offset of the opening mark
  end: number;
  labels: string[]; // notes that cite it: same sentence after the quote, else the next note in the paragraph, or the note it sits in
  inNote: string | null;
}

const OPEN = "“\"";
const QUOTE_RE = /[“"]([^“”"\n]{8,}?)[”"]/g;

/** Sentence spans within a paragraph: abbreviation-safe enough for claims and quotes. */
export function sentenceSpans(text: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /([.!?…])(["'”’)\]]*)(\s+)(?=["'“‘(\[]?[A-Z0-9])/g;
  re.lastIndex = from;
  let start = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index < to) {
    const end = m.index + m[1].length + m[2].length;
    const piece = text.slice(start, end);
    if (m[1] === "." && (/\b(e\.g|i\.e|etc|cf|vs|Dr|Prof|Mr|Mrs|Ms|St|No|Vol|Cth|Pty|Ltd|Inc|al|p|pp|s)\.$/i.test(piece) || /\b[A-Z]\.$/.test(piece))) continue;
    out.push([start, end]);
    start = end + m[3].length;
  }
  if (start < to) out.push([start, to]);
  return out;
}

export function findQuotes(text: string): FoundQuote[] {
  const { refs, defs } = parseNotes(text);
  const out: FoundQuote[] = [];
  const bodyRefs = refs.filter((r) => !r.inDefinition);
  // Quotes in the body.
  for (const b of blocks(text).filter((x) => x.kind === "paragraph")) {
    const para = text.slice(b.start, b.end);
    if (/^\s*\[\^[^\]]+\]:/.test(para)) continue; // a note definition, handled below
    const spans = sentenceSpans(text, b.start, b.end);
    for (const m of para.matchAll(QUOTE_RE)) {
      const qs = b.start + m.index!;
      const qe = qs + m[0].length;
      if (m[1].trim().split(/\s+/).length < 4) continue;
      const sent = spans.find(([a, z]) => qs >= a && qs < z) ?? [b.start, b.end];
      let labels = bodyRefs.filter((r) => r.start >= qe && r.start <= sent[1] + 1).map((r) => r.label);
      if (!labels.length) labels = bodyRefs.filter((r) => r.start >= qe && r.start < b.end).slice(0, 1).map((r) => r.label);
      if (!labels.length) labels = bodyRefs.filter((r) => r.start >= sent[0] && r.end <= qs).slice(-1).map((r) => r.label);
      out.push({ quote: m[1], start: qs, end: qe, labels, inNote: null });
    }
  }
  // Quotes inside a note: the note's own source.
  for (const d of defs) {
    const seg = text.slice(d.start, d.end);
    for (const m of seg.matchAll(QUOTE_RE)) {
      if (m[1].trim().split(/\s+/).length < 4) continue;
      out.push({ quote: m[1], start: d.start + m.index!, end: d.start + m.index! + m[0].length, labels: [d.label], inNote: d.label });
    }
  }
  void OPEN;
  void bodyStart;
  return out;
}

/** The first web address in a note's text. */
export function noteUrl(body: string): string | null {
  const m = /https?:\/\/[^\s<>)\]"”]+/.exec(body);
  return m ? m[0].replace(/[.,;:]+$/, "") : null;
}

// ---------------------------------------------------------------- matching

export function tokens(s: string): string[] {
  return s
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
}

const NEGATIONS = new Set(["not", "no", "never", "none", "nor", "without", "cannot", "can't", "won't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't"]);
const isNumber = (t: string) => /\d/.test(t);

/** Split a quote at ellipses and [bracketed] alterations: each piece must appear, in order. */
export function quotePieces(q: string): string[][] {
  return q
    .split(/\s*(?:…|\.\.\.|\[[^\]]*\])\s*/)
    .map((p) => tokens(p))
    .filter((t) => t.length >= 3);
}

export type MatchStatus = "exact" | "close" | "not_found";
export interface MatchResult {
  status: MatchStatus;
  similarity: number;
  differs: string[]; // words in the quote that differ from the closest source text
  sourceExcerpt: string;
}

const dmp = new DiffMatchPatch();

function indexOfSeq(hay: string[], needle: string[], from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Best window in the source for a piece, by word-level edit distance. */
function bestWindow(src: string[], piece: string[]): { at: number; sim: number; win: string[] } {
  // Candidate starts: positions where any of the piece's first three words occur.
  const firsts = new Set(piece.slice(0, 3));
  let best = { at: -1, sim: 0, win: [] as string[] };
  for (let i = 0; i < src.length; i++) {
    if (!firsts.has(src[i])) continue;
    for (let back = 0; back < 3; back++) {
      const s = Math.max(0, i - back);
      const win = src.slice(s, s + piece.length);
      // Word-level Levenshtein via a character map.
      const map = new Map<string, string>();
      const enc = (ws: string[]) => ws.map((w) => { if (!map.has(w)) map.set(w, String.fromCharCode(0x4e00 + map.size)); return map.get(w)!; }).join("");
      const d = dmp.diff_main(enc(piece), enc(win));
      const sim = 1 - dmp.diff_levenshtein(d) / Math.max(piece.length, win.length);
      if (sim > best.sim) best = { at: s, sim, win };
    }
  }
  return best;
}

export function matchQuote(quote: string, sourceText: string): MatchResult {
  const src = tokens(sourceText);
  const pieces = quotePieces(quote);
  if (!pieces.length) return { status: "not_found", similarity: 0, differs: [], sourceExcerpt: "" };
  // Exact: every piece found, in order.
  let pos = 0;
  let exact = true;
  let firstAt = -1;
  for (const p of pieces) {
    const at = indexOfSeq(src, p, pos);
    if (at < 0) { exact = false; break; }
    if (firstAt < 0) firstAt = at;
    pos = at + p.length;
  }
  if (exact) return { status: "exact", similarity: 1, differs: [], sourceExcerpt: src.slice(firstAt, pos).join(" ") };
  // Close: each piece's best window at 0.92 or above, with no difference in a negation or a number.
  let minSim = 1;
  const differs: string[] = [];
  const excerpts: string[] = [];
  for (const p of pieces) {
    const w = bestWindow(src, p);
    if (w.at < 0) return { status: "not_found", similarity: 0, differs: [], sourceExcerpt: "" };
    minSim = Math.min(minSim, w.sim);
    const winSet = new Set(w.win);
    const pSet = new Set(p);
    for (const t of p) if (!winSet.has(t)) differs.push(t);
    for (const t of w.win) if (!pSet.has(t) && (NEGATIONS.has(t) || isNumber(t))) differs.push(`(source: ${t})`);
    excerpts.push(w.win.join(" "));
  }
  const criticalChange = differs.some((d) => NEGATIONS.has(d.replace(/^\(source: |\)$/g, "")) || isNumber(d));
  const status: MatchStatus = minSim >= 0.92 && !criticalChange ? "close" : "not_found";
  return { status, similarity: Math.round(minSim * 100) / 100, differs, sourceExcerpt: excerpts.join(" … ") };
}
