// The Lint perspective: no model, no tokens. Runs the workspace's tell-lint over the
// scoped text and adds readability counts. Also lints comment text for the guardrail.

import { spawnSync } from "node:child_process";
import type { Level, ModelComment, Severity } from "../../shared/types.ts";

export interface LintHit {
  rule: string;
  tier: "fail" | "warn";
  line: number; // 1-based within the linted text
  excerpt: string;
}

/** Parse tell-lint's text output: "  [rule] line N: excerpt" under fail and warning headers. */
export function parseTellLint(out: string): LintHit[] {
  const hits: LintHit[] = [];
  let tier: "fail" | "warn" = "fail";
  for (const ln of out.split("\n")) {
    if (/^warnings \(not blocking\):/.test(ln)) {
      tier = "warn";
      continue;
    }
    const m = /^\s+\[([\w-]+)\]\s+(?:[\w.:/-]+:)?line (\d+): (.*)$/.exec(ln);
    if (m) hits.push({ rule: m[1], tier, line: Number(m[2]), excerpt: m[3] });
  }
  return hits;
}

export function runTellLint(python: string, script: string, text: string): LintHit[] {
  const r = spawnSync(python, [script, "--stdin"], { input: text, encoding: "utf8", timeout: 20_000, env: { ...process.env, TELL_LINT: "" } });
  // Exit 0 = clean or warnings only, 1 = fails found. Both are normal results.
  if (r.status !== 0 && r.status !== 1) throw new Error(`tell-lint failed (exit ${r.status}): ${(r.stderr || "").slice(0, 300)}`);
  return parseTellLint(r.stdout ?? "");
}

const RULE_ADVICE: Array<[RegExp, string, string]> = [
  [/^antithesis/, "'X, not Y' construction", "Keep only the positive claim; cut the contrast."],
  [/^reframe/, "Announced reframe", "State the point directly; cut the set-up."],
  [/^candour/, "Announced candour", "Cut the candour marker and state the point."],
  [/^participle-tail/, "Trailing participle", "End the sentence at the fact; give the analysis its own sentence if it is needed."],
  [/^stock/, "Stock phrase", "Cut the stock phrase or use a plain connective."],
  [/^copula-dodge/, "Copula dodge", "Use 'is' or 'has'."],
  [/^chat-leak/, "Chat leakage", "Cut the conversational filler."],
  [/^ban-/, "Banned word (your list)", "Use the plain word for what you mean."],
  [/^filler/, "Filler vocabulary", "Use a plainer, more specific word."],
  [/^aphorism/, "Punchline ending", "End the paragraph on information."],
  [/^mannered/, "Mannered phrase", "Say it plainly."],
  [/^emdash/, "Em dash", "Use a comma, colon, parenthesis or full stop."],
  [/^header-title-case/, "Title case heading", "Use sentence case."],
  [/^hedge/, "Hedge", "Keep the hedge only where the evidence is uncertain."],
  [/^absolute/, "Absolute claim", "Source it or qualify it."],
];

function advice(rule: string): [string, string] {
  for (const [re, t, h] of RULE_ADVICE) if (re.test(rule)) return [t, h];
  return [rule, "Check this against the voice card."];
}

export interface LocatedFinding extends ModelComment {
  start: number; // offsets within the linted slice
  end: number;
}

function lineStarts(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") s.push(i + 1);
  return s;
}

function mk(title: string, rationale: string, hint: string, severity: Severity, level: Level, start: number, end: number, slice: string): LocatedFinding {
  return {
    exact: slice.slice(start, end), prefix: "", suffix: "", title, rationale, hint, severity, level,
    kind: "direction", links: [], proposed_source: null, start, end,
  };
}

/** Turn tell-lint hits into findings anchored in `slice`. */
export function lintFindings(slice: string, hits: LintHit[]): LocatedFinding[] {
  const starts = lineStarts(slice);
  const out: LocatedFinding[] = [];
  for (const h of hits) {
    const ls = starts[h.line - 1];
    if (ls === undefined) continue;
    const le = slice.indexOf("\n", ls) < 0 ? slice.length : slice.indexOf("\n", ls);
    const line = slice.slice(ls, le);
    const core = h.excerpt.replace(/^\.\.\./, "").replace(/\.\.\.$/, "").trim();
    let s = ls;
    let e = le;
    const probe = core.slice(0, 40);
    const at = probe ? line.indexOf(probe) : -1;
    if (at >= 0) {
      s = ls + at;
      e = Math.min(le, s + core.length);
    }
    const [title, hint] = advice(h.rule);
    out.push(mk(title, `tell-lint ${h.tier === "fail" ? "fail" : "warning"} [${h.rule}].`, hint, h.tier === "fail" ? "should" : "consider", h.rule.startsWith("header") ? "mechanics" : "sentence", s, e, slice));
  }
  return out;
}

const HEDGES = /\b(may|might|could|perhaps|possibly|arguably|somewhat|relatively|potentially|seems?|appears?|likely|generally|tends? to)\b/gi;
const PASSIVE = /\b(is|are|was|were|be|been|being)\s+(\w+ed|\w+en)\b/gi;

/** Sentence length over 35 words, passive-heavy and hedge-heavy paragraphs. */
export function readabilityFindings(slice: string): LocatedFinding[] {
  const out: LocatedFinding[] = [];
  const masked = slice.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length)).replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  // Sentences: split on terminal punctuation followed by space or newline, within non-heading lines.
  const re = /[^.!?\n][^.!?]*?(?:[.!?](?=\s|$)|\n\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const sent = m[0];
    if (/^\s*#/.test(sent) || /^\s*\|/.test(sent) || /^\s*\[\^/.test(sent)) continue;
    const wc = sent.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    if (wc > 35) {
      const lead = sent.trim().split(/\s+/).slice(0, 4).join(" ");
      const s = m.index + sent.indexOf(sent.trim());
      out.push(mk(`Long sentence (${wc} words)`, "Readers lose the thread in sentences over about 35 words.", `Consider splitting the sentence starting '${lead}…' where the second idea begins.`, "consider", "sentence", s, s + sent.trim().length, slice));
    }
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  // Paragraph densities.
  let pos = 0;
  for (const para of masked.split(/\n\s*\n/)) {
    const s = masked.indexOf(para, pos);
    pos = s + para.length;
    if (/^\s*(#|\||\[\^|>)/.test(para)) continue;
    const words = para.split(/\s+/).filter(Boolean).length;
    if (words < 40) continue;
    const hedges = (para.match(HEDGES) ?? []).length;
    const passives = (para.match(PASSIVE) ?? []).length;
    const lead = para.trim().split(/\s+/).slice(0, 4).join(" ");
    const ts = s + para.indexOf(para.trim());
    const te = ts + Math.min(para.trim().length, 120);
    if (hedges / words > 0.04 && hedges >= 3) {
      out.push(mk(`Hedge-heavy paragraph (${hedges} hedges)`, "Stacked hedges make the claim hard to find.", `Check which hedges in the paragraph starting '${lead}…' the evidence needs, and cut the rest.`, "consider", "paragraph", ts, te, slice));
    }
    if (passives >= 4 && passives / words > 0.04) {
      out.push(mk(`Passive-heavy paragraph (${passives} passives)`, "The reader cannot see who acts.", `Name the actor in some of the passive clauses in the paragraph starting '${lead}…'.`, "consider", "paragraph", ts, te, slice));
    }
  }
  return out;
}

// Separator for batch linting. A line with no sentence punctuation stops a pattern that starts
// at the previous sentence's full stop from reaching across into the next item.
const SEP = "\n\n§\n\n";

/** Lint several one-line texts in one process. Returns the hits for each, by index. */
export function lintBatch(python: string, script: string, texts: string[]): LintHit[][] {
  const out: LintHit[][] = texts.map(() => []);
  if (!texts.length) return out;
  const body = texts.map((t) => t.replace(/\s*\n\s*/g, " ")).join(SEP);
  for (const h of runTellLint(python, script, body)) {
    const i = Math.floor((h.line - 1) / 4);
    if (out[i] && (h.line - 1) % 4 === 0) out[i].push({ ...h, line: 1 });
  }
  return out;
}

/** Guardrail rule 3: which of these comment texts trip a tell-lint fail? Returns their indexes. */
export function lintCommentTexts(python: string, script: string, texts: string[]): Set<number> {
  const res = lintBatch(python, script, texts);
  return new Set(res.flatMap((hits, i) => (hits.some((h) => h.tier === "fail") ? [i] : [])));
}

/**
 * tell-lint reports a hit on the line where its regex match starts. Some patterns start at the
 * previous sentence's full stop, so a match on line 3 can be reported on line 1. Re-lint each
 * reported line alone; if the rule does not fire there, the match is on the next non-blank line.
 */
export function relocateHits(python: string, script: string, slice: string, hits: LintHit[]): LintHit[] {
  const lines = slice.split("\n");
  const check = hits.filter((h) => !h.rule.startsWith("emdash"));
  const res = lintBatch(python, script, check.map((h) => lines[h.line - 1] ?? ""));
  return hits.map((h) => {
    const k = check.indexOf(h);
    if (k < 0 || res[k].some((x) => x.rule === h.rule)) return h;
    let n = h.line + 1;
    while (n <= lines.length && !lines[n - 1].trim()) n++;
    return n <= lines.length ? { ...h, line: n, excerpt: lines[n - 1].trim().slice(0, 96) } : h;
  });
}
