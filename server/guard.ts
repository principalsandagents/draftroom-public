// The guardrail: keeps paste-ready prose out of comments.
// A hint points at the draft and gives a direction; it never supplies wording.
// Applied to hint, rationale and example after schema validation, before storage.

import type { Level, ModelComment } from "../shared/types.ts";

export const MAX_HINT_WORDS = 45;
export const NOVEL_PHRASE_WORDS = 5; // a supplied phrase of 5+ words counts as wording
export const MECHANICS_QUOTE_WORDS = 8; // copy and proof may quote a correction up to this length
export const CONTENT_SENTENCE_WORDS = 10;

// Markers after which a model tends to supply wording.
const TRIGGERS = [
  /\be\.g\.,?\s*/i, /\bi\.e\.,?\s*/i, /\bfor example,?\s*/i, /\bfor instance,?\s*/i, /\bsuch as\s*/i,
  /\bsomething like\s*/i, /\bone option is( that)?\s*/i, /\byou could (say|write|open with|try)\s*/i,
  /\brewrite (it |this )?(as|to)\s*/i, /\brephrase (it |this )?(as|to)\s*/i, /\btry:?\s+/i, /\bsuch that\s*/i,
  /:\s+/,
];

// Verbs that start a direction. A hint sentence with none of these and no reference
// to the draft is treated as content.
const DIRECTION = new Set(
  ("consider support cut split move lead define narrow attribute add check clarify explain show qualify reorder " +
    "merge drop remove shorten name distinguish answer address connect link state test decide ask keep open close " +
    "rephrase recast reframe separate tighten specify source cite verify confirm flag group signpost trim expand " +
    "give draw say use avoid vary swap simplify start end put place bring compare correct fix spell capitalise " +
    "hyphenate number match align delete replace restore anchor tie frame acknowledge concede answer limit soften " +
    "strengthen sharpen reduce raise update note mark resolve reconcile").split(" "),
);

const DRAFT_REFS = /\b(paragraph|sentence|section|draft|reader|claim|here|this|these|that|heading|opening|close|ending|footnote|para|line|phrase|word|example|figure|quote|argument|point|list|table|title|subtitle)\b/i;

export interface GuardResult {
  ok: boolean;
  reason?: string;
  hint: string;
  rationale: string;
  flags: string[];
}

function norm(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function words(s: string): string[] {
  return s.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
}

/** Text in quotes: '…', "…", ‘…’, “…”. Apostrophes inside words are not quote marks. */
export function quotedSpans(s: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(\[])["“‘']([^"“”‘’']{2,}?)["”’'](?=$|[\s.,;:!?)\]])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1].replace(/(…|\.\.\.)$/, "").trim());
  return out;
}

function inSource(phrase: string, source: string): boolean {
  const p = norm(phrase).replace(/(…|\.\.\.)$/, "").trim();
  return p.length > 0 && source.includes(p);
}

function sentences(s: string): string[] {
  return s.split(/(?<=[.!?])\s+(?=[A-Z“"‘'(])/).map((x) => x.trim()).filter(Boolean);
}

/** Does this text supply wording that is not already in the draft or the references? */
export function suppliesWording(text: string, sourceNorm: string, level: Level, triggers = true): string | null {
  if (!text) return null;
  const quoteLimit = level === "mechanics" ? MECHANICS_QUOTE_WORDS : NOVEL_PHRASE_WORDS - 1;

  // Rule 1a: quoted strings not found in the draft.
  for (const q of quotedSpans(text)) {
    if (words(q).length > quoteLimit && !inSource(q, sourceNorm)) return `quoted wording not in draft: "${q.slice(0, 60)}"`;
  }

  // Strip quoted draft text before looking at the rest.
  let rest = text;
  for (const q of quotedSpans(text)) rest = rest.replace(q, " ");

  // Rule 1b: wording supplied after a trigger marker ("e.g.", "for example", a colon …).
  if (triggers && level !== "mechanics") {
    for (const t of TRIGGERS) {
      const m = t.exec(rest);
      if (!m) continue;
      const tail = rest.slice(m.index + m[0].length).split(/(?<=[.!?;])\s/)[0];
      const w = words(tail);
      if (tail.trim().endsWith("?")) continue;
      if (w.length >= NOVEL_PHRASE_WORDS && !inSource(tail, sourceNorm) && !startsWithDirection(w)) {
        return `wording supplied after "${m[0].trim()}"`;
      }
    }
  }

  // Rule 1c: a long sentence that gives no direction and does not refer to the draft is content.
  // Hint only: a rationale legitimately states facts about the draft's subject ("APP 8 rests on
  // accountability…"); the first real run dropped three good comments when this applied to it.
  if (!triggers) return null;
  for (const s of sentences(rest)) {
    const w = words(s);
    if (w.length < CONTENT_SENTENCE_WORDS || s.endsWith("?")) continue;
    const hasDirection = w.some((x) => DIRECTION.has(x.toLowerCase()));
    if (!hasDirection && !DRAFT_REFS.test(s)) return `content sentence: "${s.slice(0, 60)}"`;
  }
  return null;
}

function startsWithDirection(w: string[]): boolean {
  return w.length > 0 && DIRECTION.has(w[0].toLowerCase());
}

/**
 * Check one model comment. `source` is the draft text plus any reference text the run saw.
 * Returns ok:false to drop the comment.
 */
export function guardComment(c: Pick<ModelComment, "hint" | "rationale" | "level">, source: string): GuardResult {
  const src = norm(source);
  const flags: string[] = [];
  for (const field of ["hint", "rationale"] as const) {
    // Trigger markers and the content-sentence rule apply to the hint only; a rationale
    // legitimately says "for example, a CFO would ask…" and states facts.
    const why = suppliesWording(c[field], src, c.level, field === "hint");
    if (why) return { ok: false, reason: `${field}: ${why}`, hint: c.hint, rationale: c.rationale, flags };
  }
  let hint = c.hint.trim();
  if (words(hint).length > MAX_HINT_WORDS) {
    hint = sentences(hint)[0] ?? hint;
    flags.push("trimmed");
  }
  return { ok: true, hint, rationale: c.rationale.trim(), flags };
}

/** Example-on-request: must not share a four-word sequence with the anchored span. */
export function exampleOverlaps(example: string, anchored: string): boolean {
  const a = words(norm(anchored));
  const e = norm(words(example).join(" "));
  for (let i = 0; i + 4 <= a.length; i++) {
    if (e.includes(a.slice(i, i + 4).join(" "))) return true;
  }
  return false;
}
