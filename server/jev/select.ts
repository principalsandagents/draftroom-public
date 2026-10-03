// Which text may be sent to Jev. Only prose paragraphs of the body, cleaned, with facts
// computed in code so Jev never has to count or find sentence positions.

import crypto from "node:crypto";
import { bodyStart } from "../../shared/doc.ts";

export interface Eligible {
  hash: string;
  start: number;
  end: number;
  cleaned: string;
  first_sentence: string;
  last_sentence: string;
  sentence_count: number;
  has_citation: boolean;
}

export const MIN_WORDS = 25;

const ABBREV = /\b(e\.g|i\.e|etc|cf|vs|Dr|Prof|Mr|Mrs|Ms|St|No|Vol|Cth|Pty|Ltd|Inc|Co|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|al|approx|p|pp|ch|s|ss)\.$/i;

/** Split prose into sentences: full stop, question or exclamation mark, then space and a capital or quote. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /([.!?…])(["'”’)\]]*)(\s+)(?=["'“‘(\[]?[A-Z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[1].length + m[2].length;
    const piece = text.slice(start, end);
    // Not a boundary: abbreviation, initial (J. Smith) or decimal.
    if (m[1] === "." && (ABBREV.test(piece) || /\b[A-Z]\.$/.test(piece) || /\d\.$/.test(piece) && /^\d/.test(text.slice(end).trim()))) continue;
    out.push(piece.trim());
    start = end + m[3].length;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

// Note refs, links, URLs, and author-date citations such as (Smith 2020), (Smith & Jones, 2020)
// and (OECD, 2024, p. 4).
const CITATION = /\[n\]|\]\(https?:|https?:\/\/|\(\s*(?:see\s+|cf\.?\s+)?[A-Z][\w'’.\- ]*(?:(?:,\s*|\s+(?:&|and)\s+)[A-Z][\w'’.\- ]*)*(?: et al\.?)?,?\s+(?:19|20)\d\d[a-z]?(?:,\s*(?:pp?\.|para)\s*[\d\-–]+)?\s*\)/;

export function hashText(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** Remove what must never be sent, and neutralise note references. */
export function clean(p: string): string {
  return p
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\[\^[^\]\s]+\]/g, "[n]")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Body prose paragraphs that may be sent. Never: Prep, headings, blockquotes, tables (pipe or
 * grid), images, code, note definitions, HTML comments, lists, or text inside tell-lint quoted blocks.
 */
export function eligibleParagraphs(text: string): Eligible[] {
  const from = bodyStart(text);
  const body = text.slice(from);
  const out: Eligible[] = [];
  // Quoted-material blocks are blanked first (same length, so offsets hold).
  const masked = body.replace(/<!-- tell-lint: quoted -->[\s\S]*?<!-- \/tell-lint: quoted -->/g, (m) => m.replace(/[^\n]/g, " "));
  let pos = 0;
  let inFence = false;
  const lines = masked.split("\n");
  let block: Array<{ text: string; start: number }> = [];
  const flush = () => {
    if (!block.length) return;
    const first = block[0].text;
    const isProse =
      !/^\s*(#{1,6}\s|>|\||\+[-=:+]|!\[|\[\^[^\]]+\]:|<!--|[-*+]\s|\d+[.)]\s|```|~~~|<\/?[a-z])/i.test(first) &&
      !block.some((l) => /^\s*(\||\+[-=:+])/.test(l.text));
    if (isProse) {
      const start = from + block[0].start;
      const last = block[block.length - 1];
      const end = from + last.start + last.text.length;
      const raw = text.slice(start, end);
      const cleaned = clean(raw);
      const words = cleaned.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
      const sents = sentences(cleaned);
      if (words >= MIN_WORDS && sents.length >= 2) {
        out.push({
          hash: hashText(cleaned), start, end, cleaned,
          first_sentence: sents[0], last_sentence: sents[sents.length - 1], sentence_count: sents.length,
          has_citation: CITATION.test(cleaned),
        });
      }
    }
    block = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
    } else if (inFence) {
      // skip
    } else if (!line.trim()) {
      flush();
    } else {
      block.push({ text: line, start: pos });
    }
    pos += line.length + 1;
  }
  flush();
  return out;
}
