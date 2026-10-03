// Build the formatting preview: parse every note, fill URL-only sources from pages already in
// the library, render each stream in the chosen style, and return before and after for each
// note that changes. Nothing is written to the draft here.

import crypto from "node:crypto";
import { parseNotes, labelParts } from "../../shared/notes.ts";
import { parseNotesWithClaude, sourceKey, toCsl, toRef, type ParsedSource, type Segment } from "./parse.ts";
import { renderStream, type NoteStyle, type CslItem, type NoteCluster } from "./format.ts";
import { readCiteState, writeCiteState } from "./state.ts";
import { idForUrl, cardMeta } from "./library.ts";
import { libraryDir, sourceForUrl } from "./check.ts";
import type { Profile } from "../profile.ts";

export interface PreviewEntry {
  label: string;
  before: string;
  after: string;
  warnings: string[];
  filled: Array<{ field: string; value: string; from: string }>;
  lossy: boolean; // the formatted note would drop words or numbers from the original: unticked in the preview
}

export interface Preview {
  style: NoteStyle;
  entries: PreviewEntry[];
  unchanged: number;
  skipped: Array<{ label: string; reason: string }>;
  order_key: string;
}

/** Reading-order key for each stream: changes whenever notes are added, removed or reordered. */
export function orderKey(text: string): string {
  const { refs } = parseNotes(text);
  const seen: string[] = [];
  for (const r of refs) if (!r.inDefinition && !seen.includes(r.label)) seen.push(r.label);
  return crypto.createHash("sha1").update(seen.join(",")).digest("hex").slice(0, 12);
}

/** Page metadata from the library, fetching the page first if it is not there yet. */
async function pageInfo(prof: Profile, url: string, draft: string) {
  try {
    const id = idForUrl(url);
    let m = cardMeta(libraryDir(prof), id);
    if (!m) {
      await sourceForUrl(prof, url, draft); // saves to the library when it can be read
      m = cardMeta(libraryDir(prof), id);
    }
    return m;
  } catch {
    return null;
  }
}

const KEEP_OK = new Set(["see", "here", "also", "the", "and", "at", "in", "of", "on", "from", "available", "accessed", "quoted", "via", "online", "cf", "eg", "ie", "per", "for"]);

/** Words and numbers in the original citation text that the formatted text no longer contains. */
export function lostWords(original: string, after: string): string[] {
  const strip = (s: string) => s.replace(/https?:\/\/\S+/g, " ").normalize("NFKC").toLowerCase();
  const toks = (s: string) => strip(s).match(/[\p{L}]{3,}|\d+/gu) ?? [];
  const have = new Set(toks(after));
  return [...new Set(toks(original))].filter((t) => !KEEP_OK.has(t) && !have.has(t));
}

export async function formatPreview(prof: Profile, draft: string, text: string, style: NoteStyle): Promise<Preview> {
  const st = readCiteState(draft);
  const cache = (st.parse_cache ?? {}) as Record<string, Segment[]>;
  const { defs } = parseNotes(text);
  const managed = defs.filter((d) => labelParts(d.label));
  const skipped = defs.filter((d) => !labelParts(d.label)).map((d) => ({ label: d.label, reason: "plain label: use Renumber first" }));
  const parsed = await parseNotesWithClaude(managed.map((d) => ({ label: d.label, body: d.body })), cache);
  st.parse_cache = cache;

  // Items, deduplicated across notes so later citations take short forms.
  const items: Record<string, CslItem> = {};
  const idByKey = new Map<string, string>();
  const filledByNote = new Map<string, PreviewEntry["filled"]>();
  // Fill URL-only and thin web sources from the page's own metadata (fetched once, kept in the library).
  const infoByUrl = new Map<string, Awaited<ReturnType<typeof pageInfo>>>();
  for (const p of parsed) for (const seg of p.segments) for (const s of seg.sources ?? []) {
    if (s.url && !infoByUrl.has(s.url) && (!s.title || !s.year || !s.container)) infoByUrl.set(s.url, await pageInfo(prof, s.url, draft));
  }
  const itemFor = (label: string, s: ParsedSource): string => {
    const src = { ...s };
    const info = src.url ? infoByUrl.get(src.url) : null;
    const fill = (field: string, value: string) => {
      const f = filledByNote.get(label) ?? [];
      f.push({ field, value, from: "the page itself" });
      filledByNote.set(label, f);
    };
    if (info) {
      if (!src.title && info.title) { src.title = info.title; fill("title", info.title); }
      if (!src.container && info.site && info.site.toLowerCase() !== (src.title ?? "").toLowerCase() && ["webpage", "post-weblog", "article-newspaper", "article-magazine"].includes(src.type)) { src.container = info.site; fill("site", info.site); }
      if (!src.authors?.length && info.authors?.length) { src.authors = info.authors.map((a) => ({ literal: a })); fill("author", info.authors.join(", ")); }
      if (!src.year && info.published && /^\d{4}/.test(info.published)) {
        const [y, mo, da] = info.published.split("-").map(Number);
        src.year = y; if (mo) src.month = mo; if (mo && da) src.day = da;
        fill("date", info.published);
      }
      if (src.type === "webpage" && info.site && src.container) src.type = info.authors?.length ? "article-newspaper" : "webpage";
    }
    const key = sourceKey(src);
    if (!idByKey.has(key)) {
      const id = `s${idByKey.size + 1}`;
      idByKey.set(key, id);
      items[id] = toCsl(id, src);
    }
    return idByKey.get(key)!;
  };

  const clusters: Record<"FN" | "EN", NoteCluster[]> = { FN: [], EN: [] };
  const segKeys = new Map<string, string[]>(); // label -> cluster keys per segment (or "" for commentary)
  for (const p of [...parsed].sort((a, b) => labelParts(a.label)!.n - labelParts(b.label)!.n)) {
    const parts = labelParts(p.label)!;
    const keys: string[] = [];
    p.segments.forEach((seg, i) => {
      if (seg.kind !== "citation" || !p.ok) return keys.push("");
      const key = `${p.label}#${i}`;
      clusters[parts.kind].push({ key, noteNumber: parts.n, refs: seg.sources!.map((s) => toRef(itemFor(p.label, s), s)) });
      keys.push(key);
    });
    segKeys.set(p.label, keys);
  }
  const rendered = { ...renderStream(style, items, clusters.FN), ...renderStream(style, items, clusters.EN) };

  const entries: PreviewEntry[] = [];
  let unchanged = 0;
  for (const p of parsed) {
    const def = managed.find((d) => d.label === p.label)!;
    if (!p.ok) {
      skipped.push({ label: p.label, reason: p.warnings.join("; ") });
      continue;
    }
    const keys = segKeys.get(p.label)!;
    const after = p.segments
      .map((seg, i) => {
        if (!keys[i]) return seg.text;
        const lead = /^\s*/.exec(seg.text)![0];
        const trail = /\s*$/.exec(seg.text)![0];
        return `${lead}${(rendered[keys[i]] ?? seg.text.trim()).replace(/\s{2,}/g, " ")}${trail}`;
      })
      .join("");
    const lost = lostWords(p.segments.filter((s) => s.kind === "citation").map((s) => s.text).join(" "), after);
    const warnings = [...p.warnings, ...(lost.length ? [`would drop: ${lost.join(", ")} (left unticked; check before accepting)`] : [])];
    if (after === def.body) unchanged++;
    else entries.push({ label: p.label, before: def.body, after, warnings, filled: filledByNote.get(p.label) ?? [], lossy: lost.length > 0 });
  }
  st.style = style;
  writeCiteState(draft, st);
  return { style, entries, unchanged, skipped, order_key: orderKey(text) };
}

export function recordAccepted(draft: string, style: string, order_key: string) {
  const st = readCiteState(draft);
  st.formatted = { style, order_key, at: new Date().toISOString() };
  writeCiteState(draft, st);
}
