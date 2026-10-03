// The automatic quote check: for every quote in the draft, find its note's source (a linked
// file, or the note's web address), fetch or reuse it from the library, and match the quote
// word for word. Results become Citations cards ([Cite]) and the library's verification log.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseNotes } from "../../shared/notes.ts";
import { locateBlock } from "../../shared/doc.ts";
import { fetchSource, pdfText, htmlText, docxText, DEFAULT_DENIED_DOMAINS, wordCount } from "./fetch.ts";
import { findQuotes, noteUrl, matchQuote } from "./quotes.ts";
import { idForUrl, idForUpload, saveSource, existingText, appendLog, noteCitedBy, sha1 } from "./library.ts";
import { readCiteState, writeCiteState, suffixOf, type QuoteCheck } from "./state.ts";
import { loadComments, writeSidecar, replaceCards } from "../store.ts";
import { isUnder, type Profile } from "../profile.ts";
import type { Comment } from "../../shared/types.ts";

export function libraryDir(prof: Profile): string {
  return prof.library_dir ?? (prof.workspace ? path.join(prof.workspace, "reference", "library") : path.join(process.env.DRAFTROOM_HOME ?? path.join(os.homedir(), ".draftroom"), "library"));
}

function deniedDomains(prof: Profile): string[] {
  return prof.cite_denied_domains ?? DEFAULT_DENIED_DOMAINS;
}

interface SourceText {
  id: string;
  text: string;
  label: string; // what to show: domain or file name
}

const fetchCache = new Map<string, Promise<SourceText | { reason: string }>>();

export async function sourceForUrl(prof: Profile, url: string, draft: string): Promise<SourceText | { reason: string }> {
  const lib = libraryDir(prof);
  let id: string;
  try {
    id = idForUrl(url);
  } catch {
    return { reason: "the note's web address is not valid" };
  }
  const have = existingText(lib, id);
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (have) {
    noteCitedBy(lib, id, draft);
    return { id, text: have, label: host };
  }
  if (!fetchCache.has(url)) {
    fetchCache.set(url, (async () => {
      const f = await fetchSource(url, deniedDomains(prof));
      if (!f.ok) return { reason: f.reason };
      const ext = f.kind === "pdf" ? "pdf" : f.kind === "html" ? "html" : "txt";
      saveSource(lib, id, ext, f.bytes, f.text, { origin: "fetched", url, finalUrl: f.finalUrl, title: f.title, kind: f.kind, site: f.meta.site, published: f.meta.published, authors: f.meta.authors, doi: f.meta.doi });
      return { id, text: f.text, label: host };
    })());
  }
  const r = await fetchCache.get(url)!;
  fetchCache.delete(url);
  if ("id" in r) noteCitedBy(lib, r.id, draft);
  return r;
}

export interface QuoteRunResult {
  quotes: number;
  exact: number;
  close: number;
  not_found: number;
  not_checked: number;
}

export async function checkQuotes(prof: Profile, draft: string, text: string): Promise<QuoteRunResult> {
  const lib = libraryDir(prof);
  const st = readCiteState(draft);
  const { defs } = parseNotes(text);
  const defByLabel = new Map(defs.map((d) => [d.label, d]));
  const found = findQuotes(text);
  const results: QuoteCheck[] = [];
  const now = new Date().toISOString();
  for (const q of found) {
    const label = q.labels[0] ?? null;
    const base = { quote: q.quote, label, checked_at: now };
    if (!label || !defByLabel.has(label)) {
      results.push({ ...base, status: "not_checked", detail: "No note cites this quote, so there is no source to check it against.", source: null, library_id: null });
      continue;
    }
    const suf = suffixOf(label);
    let src: SourceText | { reason: string };
    const linked = st.links[suf];
    if (linked && existingText(lib, linked)) {
      src = { id: linked, text: existingText(lib, linked)!, label: "linked file" };
    } else {
      const url = noteUrl(defByLabel.get(label)!.body);
      src = url ? await sourceForUrl(prof, url, draft) : { reason: "The note has no web address and no linked file." };
      if ("id" in src) st.sources[suf] = src.id;
    }
    if (!("id" in src)) {
      results.push({ ...base, status: "not_checked", detail: src.reason, source: noteUrl(defByLabel.get(label)!.body), library_id: null });
      continue;
    }
    const m = matchQuote(q.quote, src.text);
    const detail =
      m.status === "exact" ? `Found word for word in ${src.label}.`
      : m.status === "close" ? `Close match in ${src.label} (${Math.round(m.similarity * 100)}%). Differs: ${m.differs.join(", ")}. Source reads: "${m.sourceExcerpt.slice(0, 200)}"`
      : m.sourceExcerpt ? `Not found in ${src.label}. Nearest text: "${m.sourceExcerpt.slice(0, 200)}"${m.differs.length ? `; differs: ${m.differs.join(", ")}` : ""}`
      : `Not found in ${src.label}.`;
    results.push({ ...base, status: m.status, detail, source: src.label, library_id: src.id });
    appendLog(lib, src.id, "quote", m.status, `"${q.quote.split(/\s+/).slice(0, 10).join(" ")}…"`);
  }
  st.quotes = results;
  writeCiteState(draft, st);
  writeQuoteComments(draft, text, found, results);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return { quotes: results.length, exact: count("exact"), close: count("close"), not_found: count("not_found"), not_checked: count("not_checked") };
}

/** One card per quote that is not an exact match. Earlier quote cards are replaced. */
function writeQuoteComments(draft: string, text: string, found: ReturnType<typeof findQuotes>, results: QuoteCheck[]) {
  const sc = loadComments(draft, text);
  const now = new Date().toISOString();
  const cards: Comment[] = [];
  results.forEach((r, i) => {
    if (r.status === "exact") return;
    const q = found[i];
    const where = locateBlock(text, q.start);
    const title = r.status === "close" ? "Quote differs slightly from the source" : r.status === "not_found" ? "Quote not found in the source" : "Quote not checked against a source";
    const hint = r.status === "not_checked" ? "Link the source file to this note (Citations tab), or add the source's web address to the note." : "Check the quote against the source and correct the wording or the citation.";
    cards.push({
      id: `cite-quote-${i}-${Buffer.from(r.quote).toString("base64url").slice(0, 10)}`, perspective: "citations", engine: "cite", run_id: `cite-${now.slice(0, 10)}`,
      level: "sentence", severity: r.status === "not_found" ? "should" : "consider", kind: "check",
      anchor: { exact: text.slice(q.start, q.end), prefix: text.slice(Math.max(0, q.start - 30), q.start), suffix: text.slice(q.end, q.end + 30), start: q.start, end: q.end, section: where.section, paragraph: where.paragraph },
      scope: "document", title, rationale: r.detail, hint, links: [], proposed_source: null, example: null,
      status: "open", dismiss_reason: null, stale: false, flags: ["cite"], created: now,
    });
  });
  replaceCards(sc, (c) => c.engine === "cite" && c.id.startsWith("cite-quote-"), cards);
  const ok = results.filter((r) => r.status === "exact").length;
  sc.summaries.citations = { summary: `${results.length} quote${results.length === 1 ? "" : "s"}: ${ok} found word for word, ${results.length - ok} to look at.`, run_id: `cite-${now.slice(0, 10)}`, engine: "cite", at: now };
  writeSidecar(draft, sc);
}

// ---------------------------------------------------------------- link a file

const deniedHashes = new Map<string, Set<string>>();

/** Hashes of every file under the profile's denied paths, so a copy cannot be linked in. */
function deniedFileHashes(prof: Profile): Set<string> {
  const key = prof.denied_paths.join("|");
  if (deniedHashes.has(key)) return deniedHashes.get(key)!;
  const set = new Set<string>();
  const walk = (d: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(pdf|docx?|html?|txt|md|epub)$/i.test(e.name)) {
        try {
          if (fs.statSync(p).size < 60 * 1024 * 1024) set.add(sha1(fs.readFileSync(p)));
        } catch {
          /* unreadable */
        }
      }
    }
  };
  for (const d of prof.denied_paths) walk(d, 0);
  deniedHashes.set(key, set);
  return set;
}

export async function linkFile(prof: Profile, draft: string, label: string, name: string, bytes: Buffer): Promise<{ id: string; words: number }> {
  if (deniedFileHashes(prof).has(sha1(bytes))) throw new Error("This file is a copy of licensed or private material Draftroom must not store (for example the standards corpus).");
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  let text: string;
  if (ext === "pdf" || bytes.subarray(0, 5).toString() === "%PDF-") text = await pdfText(bytes);
  else if (ext === "docx") text = await docxText(bytes);
  else if (ext === "html" || ext === "htm") text = (await htmlText(bytes.toString("utf8"))).text;
  else if (["txt", "md", "markdown"].includes(ext)) text = bytes.toString("utf8");
  else throw new Error("Link a PDF, Word (.docx), HTML, text or markdown file.");
  const words = wordCount(text);
  if (words < 20) throw new Error("No readable text in this file (a scanned PDF needs text recognition first).");
  const lib = libraryDir(prof);
  const id = idForUpload(name, bytes);
  saveSource(lib, id, ext || "bin", bytes, text, { origin: "linked", originalName: name, kind: ext });
  noteCitedBy(lib, id, draft);
  const st = readCiteState(draft);
  st.links[suffixOf(label)] = id;
  writeCiteState(draft, st);
  return { id, words };
}

/** Quotes verified against their sources, for the Evidence reviewer's prompt. */
export function verifiedQuotesForPrompt(draft: string): string[] {
  return readCiteState(draft).quotes.filter((q) => q.status === "exact" || q.status === "close").map((q) => `- "${q.quote.slice(0, 120)}" (${q.status === "exact" ? "word for word" : "close"} in ${q.source}, checked ${q.checked_at.slice(0, 10)})`);
}

export { isUnder };
