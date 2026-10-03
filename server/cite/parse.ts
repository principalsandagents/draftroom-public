// Claude reads notes into segments and sources; code checks the result before trusting it.
// Guard: segments must reproduce the note text exactly, and every field value must appear in
// its segment (or come from a named lookup). A note that fails is left untouched.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { claudeJson } from "./claude.ts";
import { REPO } from "../profile.ts";
import type { CslItem, CiteRef } from "./format.ts";

export interface ParsedSource {
  type: string;
  authors?: Array<{ family?: string; given?: string; literal?: string }>;
  title?: string;
  container?: string;
  publisher?: string;
  place?: string;
  year?: number;
  month?: number;
  day?: number;
  url?: string;
  doi?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  number?: string;
  jurisdiction?: string;
  genre?: string;
  event?: string; // conference, panel or hearing where something was said
  locator?: string;
  locator_label?: string;
  prefix?: string;
}

export interface Segment {
  kind: "citation" | "commentary";
  text: string;
  sources?: ParsedSource[];
}

export interface ParsedNote {
  label: string;
  ok: boolean;
  segments: Segment[];
  warnings: string[];
}

const STR = { type: "string" };
const SOURCE = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["webpage", "post-weblog", "article-journal", "article-newspaper", "article-magazine", "report", "book", "chapter", "legislation", "legal_case", "speech", "interview", "personal_communication", "document"] },
    authors: { type: "array", items: { type: "object", properties: { family: STR, given: STR, literal: STR } } },
    title: STR, container: STR, publisher: STR, place: STR, year: { type: "integer" }, month: { type: "integer" }, day: { type: "integer" },
    url: STR, doi: STR, volume: STR, issue: STR, pages: STR, number: STR, jurisdiction: STR, genre: STR, event: STR,
    locator: STR, locator_label: { type: "string", enum: ["page", "paragraph", "section", "chapter", "part", "clause"] }, prefix: STR,
  },
  required: ["type"],
};
export const PARSE_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: STR,
          segments: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["citation", "commentary"] }, text: STR, sources: { type: "array", items: SOURCE } }, required: ["kind", "text"] } },
        },
        required: ["label", "segments"],
      },
    },
  },
  required: ["notes"],
};

export function norm(s: string): string {
  return s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").toLowerCase().trim();
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Drop any field whose value is not in the segment's text. Returns warnings for what was dropped. */
export function guardSource(s: ParsedSource, segText: string): { source: ParsedSource; warnings: string[] } {
  const seg = norm(segText);
  const has = (v: string) => seg.includes(norm(v)) || seg.includes(norm(v).replace(/\/$/, ""));
  const out: ParsedSource = { type: s.type };
  const warnings: string[] = [];
  const keep = (k: keyof ParsedSource, v: unknown, ok: boolean) => {
    if (v === undefined || v === null || v === "") return;
    if (ok) (out as any)[k] = v;
    else warnings.push(`left out ${k} "${String(v).slice(0, 40)}" (not in the note)`);
  };
  for (const k of ["title", "container", "publisher", "place", "url", "doi", "volume", "issue", "pages", "number", "jurisdiction", "genre", "event", "locator", "prefix"] as const) {
    const v = s[k];
    if (typeof v === "string") keep(k, v.trim(), has(v.trim()));
  }
  if (s.locator_label && out.locator) out.locator_label = s.locator_label;
  const authors = (s.authors ?? []).filter((a) => {
    const name = a.literal ?? a.family ?? "";
    const ok = !!name && has(name);
    if (name && !ok) warnings.push(`left out author "${name}" (not in the note)`);
    return ok;
  });
  if (authors.length) out.authors = authors;
  if (s.year && seg.includes(String(s.year))) {
    out.year = s.year;
    if (s.month && (seg.includes(MONTHS[s.month - 1] ?? "~") || seg.includes(MONTHS[s.month - 1]?.slice(0, 3) ?? "~"))) {
      out.month = s.month;
      if (s.day && new RegExp(`\\b${s.day}\\b`).test(seg)) out.day = s.day;
    }
  } else if (s.year) warnings.push(`left out year ${s.year} (not in the note)`);
  return { source: out, warnings };
}

export function checkParse(label: string, body: string, segments: Segment[]): ParsedNote {
  const joined = segments.map((s) => s.text).join("");
  const sameText = joined === body || joined.replace(/\s+/g, " ").trim() === body.replace(/\s+/g, " ").trim();
  if (!sameText || !segments.length) return { label, ok: false, segments: [{ kind: "commentary", text: body }], warnings: ["could not be read safely: left as written"] };
  const warnings: string[] = [];
  const segs: Segment[] = segments.map((s) => {
    if (s.kind !== "citation") return { kind: "commentary", text: s.text };
    const sources = (s.sources ?? []).map((src) => {
      const g = guardSource(src, s.text);
      warnings.push(...g.warnings);
      return g.source;
    }).filter((src) => src.title || src.url || src.authors?.length || src.doi);
    return sources.length ? { kind: "citation", text: s.text, sources } : { kind: "commentary", text: s.text };
  });
  return { label, ok: true, segments: segs, warnings };
}

function hash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** Parse notes with Claude (cached by note text), then guard each. */
export async function parseNotesWithClaude(notes: Array<{ label: string; body: string }>, cache: Record<string, Segment[]>): Promise<ParsedNote[]> {
  const todo = notes.filter((n) => !cache[hash(n.body)]);
  const brief = fs.readFileSync(path.join(REPO, "perspectives", "_citations-parse.md"), "utf8").replace("<!-- tell-lint: off -->", "");
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const prompt = `${brief}\n\n---\n\n## Notes to read\n\nReturn every note below, with its label, in the same order.\n\n${batch.map((n) => `### ${n.label}\n<note>${n.body}</note>`).join("\n\n")}`;
    const out = (await claudeJson("citations-parse", prompt, PARSE_SCHEMA)) as { notes: Array<{ label: string; segments: Segment[] }> };
    for (const n of out.notes ?? []) {
      const src = batch.find((b) => b.label === n.label);
      if (src) cache[hash(src.body)] = n.segments;
    }
  }
  return notes.map((n) => {
    const segs = cache[hash(n.body)];
    return segs ? checkParse(n.label, n.body, segs) : { label: n.label, ok: false, segments: [{ kind: "commentary", text: n.body }], warnings: ["Claude did not return this note: left as written"] };
  });
}

export { hash as noteHash };

// ---------------------------------------------------------------- to CSL

export function sourceKey(s: ParsedSource): string {
  if (s.doi) return `doi:${s.doi.toLowerCase()}`;
  if (s.url) return `url:${s.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase()}`;
  return `t:${norm(s.title ?? "")}|${s.year ?? ""}|${norm(s.authors?.[0]?.literal ?? s.authors?.[0]?.family ?? "")}`;
}

export function toCsl(id: string, s: ParsedSource): CslItem {
  const date = s.year ? { "date-parts": [[s.year, ...(s.month ? [s.month] : []), ...(s.month && s.day ? [s.day] : [])]] } : undefined;
  return {
    id, type: s.type === "document" ? "document" : s.type,
    ...(s.title ? { title: s.title } : {}),
    ...(s.authors?.length ? { author: s.authors } : {}),
    ...(s.container ? { "container-title": s.container } : {}),
    ...(s.publisher ? { publisher: s.publisher } : {}),
    ...(s.place ? { "publisher-place": s.place } : {}),
    ...(date ? { issued: date } : {}),
    ...(s.url ? { URL: s.url } : {}),
    ...(s.doi ? { DOI: s.doi } : {}),
    ...(s.volume ? { volume: s.volume } : {}),
    ...(s.issue ? { issue: s.issue } : {}),
    ...(s.pages ? { page: s.pages } : {}),
    ...(s.number ? { number: s.number } : {}),
    ...(s.jurisdiction ? { jurisdiction: s.jurisdiction } : {}),
    ...(s.genre ? { genre: s.genre } : {}),
    ...(s.event ? { "event-title": s.event, event: s.event } : {}),
  };
}

export function toRef(id: string, s: ParsedSource): CiteRef {
  return { id, ...(s.locator ? { locator: s.locator, label: s.locator_label ?? "page" } : {}), ...(s.prefix ? { prefix: `${s.prefix.replace(/:\s*$/, "")} ` } : {}) };
}
