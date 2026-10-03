// Release C: validate each reference. Exists and details (Crossref, OpenAlex, the URL), full
// text (linked file, open-access copy, the page), relevance and support (Claude, on the
// abstract and passages chosen by code, with its quoted passage checked against the source).

import fs from "node:fs";
import path from "node:path";
import { parseNotes, labelParts } from "../../shared/notes.ts";
import { blocks, locateBlock } from "../../shared/doc.ts";
import { parseNotesWithClaude, type ParsedSource, type Segment } from "./parse.ts";
import { crossref, openalex, unpaywall, compareDetails, type LookupRecord } from "./lookup.ts";
import { sentenceSpans, matchQuote, tokens } from "./quotes.ts";
import { sourceForUrl, libraryDir } from "./check.ts";
import { deniedDomain, DEFAULT_DENIED_DOMAINS } from "./fetch.ts";
import { existingText, appendLog, idForUrl } from "./library.ts";
import { readCiteState, writeCiteState, suffixOf } from "./state.ts";
import { claudeJson } from "./claude.ts";
import { loadComments, writeSidecar, replaceCards } from "../store.ts";
import { REPO, type Profile } from "../profile.ts";
import type { Comment } from "../../shared/types.ts";

const SCHOLARLY = new Set(["article-journal", "book", "chapter", "report", "article-magazine"]);
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    relevance: { type: "string", enum: ["relevant", "partly", "not_relevant", "cannot_tell"] },
    support: { type: "string", enum: ["supported", "partly", "not_supported", "not_found_in_passages", "no_text"] },
    reason: { type: "string" },
    passage: { type: "string" },
  },
  required: ["relevance", "support", "reason", "passage"],
};

export interface SourceResult {
  label: string; // what the source is, briefly
  exists: { status: "found" | "url_answers" | "not_found" | "lead_only" | "not_checked"; detail: string; via?: string };
  details: { status: "ok" | "differs" | "not_checked"; diffs: string[] };
  fulltext: { status: "saved" | "linked" | "abstract_only" | "none"; detail: string; library_id?: string };
  relevance: { status: string; detail: string };
  support: { status: string; detail: string; passage?: string; passage_verified?: boolean };
}

export interface NoteValidation {
  claim: string;
  at: string;
  sources: SourceResult[];
}

/** The claim a note is attached to: its sentence, plus the one before when it is short. */
export function claimFor(text: string, label: string): { claim: string; start: number; end: number } | null {
  const { refs } = parseNotes(text);
  const ref = refs.find((r) => r.label === label && !r.inDefinition);
  if (!ref) return null;
  const b = blocks(text).find((x) => x.kind === "paragraph" && ref.start >= x.start && ref.start < x.end);
  if (!b) return null;
  // Note labels are invisible to sentence splitting: "assessment.[^FN01-ab12] A later…" is two sentences.
  const masked = text.replace(/\[\^[^\]\s]+\]/g, (m) => " ".repeat(m.length));
  const spans = sentenceSpans(masked, b.start, b.end);
  let i = spans.findIndex(([a, z]) => ref.start >= a && ref.start < z);
  if (i < 0) {
    // The label sits in the gap after a sentence: it belongs to that sentence.
    i = spans.findIndex(([, z], k) => ref.start >= z && (k + 1 >= spans.length || ref.start < spans[k + 1][0]));
    if (i < 0) i = spans.length - 1;
  }
  // A note at the very start of a sentence belongs to the sentence before it.
  if (i > 0 && ref.start - spans[i][0] < 3) i--;
  let [start, end] = spans[i];
  const clean = (s: string) => s.replace(/\[\^[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  if (clean(text.slice(start, end)).split(" ").length < 12 && i > 0) start = spans[i - 1][0];
  return { claim: clean(text.slice(start, end)), start, end };
}

/** The six chunks of the source that share the most content words with the claim. */
export function retrievePassages(sourceText: string, claim: string, k = 6): string[] {
  const stop = new Set("that this with from have will were been their there which about would could should these those into than then also more most such they them what when where while very much many some only other over under between".split(" "));
  const key = (w: string) => w.slice(0, 6);
  const want = new Set(tokens(claim).filter((w) => w.length >= 4 && !stop.has(w)).map(key));
  const words = sourceText.replace(/\s+/g, " ").split(" ");
  const chunks: Array<{ text: string; score: number }> = [];
  for (let i = 0; i < words.length; i += 200) {
    const text = words.slice(i, i + 300).join(" ");
    const seen = new Set(tokens(text).map(key));
    let score = 0;
    for (const w of want) if (seen.has(w)) score++;
    if (score) chunks.push({ text, score });
    if (i + 300 >= words.length) break;
  }
  return chunks.sort((a, b) => b.score - a.score).slice(0, k).map((c) => c.text);
}

function describe(s: ParsedSource): string {
  const who = s.authors?.[0]?.literal ?? s.authors?.[0]?.family ?? "";
  return [who, s.title ? `‘${s.title}’` : "", s.year ?? ""].filter(Boolean).join(", ") || s.url || "source";
}

async function validateSource(prof: Profile, draft: string, noteLabel: string, s: ParsedSource, claim: string, linkedId: string | null): Promise<SourceResult> {
  const email = prof.contact_email;
  const denied = prof.cite_denied_domains ?? DEFAULT_DENIED_DOMAINS;
  const lib = libraryDir(prof);
  const res: SourceResult = {
    label: describe(s),
    exists: { status: "not_checked", detail: "" },
    details: { status: "not_checked", diffs: [] },
    fulltext: { status: "none", detail: "" },
    relevance: { status: "cannot_tell", detail: "" },
    support: { status: "no_text", detail: "" },
  };
  const host = s.url ? (() => { try { return new URL(s.url!).hostname; } catch { return ""; } })() : "";
  if (host && deniedDomain(host, denied)) {
    res.exists = { status: "lead_only", detail: `${host} is a paid or licensed source: never fetched. Cite the primary source it reports on.` };
    return res;
  }

  // 1. Exists, and the note's details.
  let record: LookupRecord | null = null;
  if (s.doi || (s.title && SCHOLARLY.has(s.type))) {
    record = await crossref(s, email);
    const oa = await openalex(s, record?.doi ?? s.doi, email);
    if (oa && record) record = { ...record, abstract: oa.abstract, oaUrl: oa.oaUrl };
    else if (oa) record = oa;
  }
  let page: { id: string; text: string } | null = null;
  if (record) {
    res.exists = { status: "found", detail: `${record.source === "crossref" ? "Crossref" : "OpenAlex"}: “${record.title}”${record.year ? ` (${record.year})` : ""}`, via: record.source };
    const diffs = compareDetails(s, record);
    res.details = diffs.length ? { status: "differs", diffs } : { status: "ok", diffs: [] };
  }
  if (s.url) {
    const got = await sourceForUrl(prof, s.url, draft);
    if ("id" in got) {
      page = { id: got.id, text: got.text };
      if (!record) res.exists = { status: "url_answers", detail: `The web address answers (${host}). Not in Crossref or OpenAlex, so publication details were not checked.` };
    } else if (!record) {
      // Only a missing page or an unknown address means the source may not exist; a refusal,
      // a script-only page or a timeout means it could not be checked.
      const missing = /HTTP (404|410)|could not find/.test(got.reason);
      res.exists = { status: missing ? "not_found" : "not_checked", detail: missing ? `The web address does not answer: ${got.reason}` : `The page could not be read automatically: ${got.reason}. Link a saved copy to check it.` };
    }
  }
  if (!record && !s.url) res.exists = s.title ? { status: "not_found", detail: "Not found in Crossref or OpenAlex, and the note has no web address." } : { status: "not_checked", detail: "The note gives no title or web address to look up: add the source details." };

  // 2. Full text: a linked file, an open-access copy, or the page itself.
  let full: { id: string; text: string; how: "linked" | "saved" } | null = null;
  if (linkedId && existingText(lib, linkedId)) full = { id: linkedId, text: existingText(lib, linkedId)!, how: "linked" };
  if (!full && record?.doi) {
    const oaUrl = (await unpaywall(record.doi, email)) ?? record.oaUrl;
    if (oaUrl) {
      const got = await sourceForUrl(prof, oaUrl, draft);
      if ("id" in got) full = { id: got.id, text: got.text, how: "saved" };
    }
  }
  if (!full && page) full = { ...page, how: "saved" };
  if (full) res.fulltext = { status: full.how, detail: full.how === "linked" ? "Checked against your linked file." : "Full text fetched and saved in the reference library.", library_id: full.id };
  else res.fulltext = { status: record?.abstract ? "abstract_only" : "none", detail: "No full text available: the claim was not checked against the source. Link a file to check it." };

  // 3. Relevance and support.
  if (!claim) {
    res.relevance = { status: "cannot_tell", detail: "The note is not attached to a sentence in the text." };
    return res;
  }
  const passages = full ? retrievePassages(full.text, claim) : [];
  if (!passages.length && !record?.abstract) {
    res.support = { status: "no_text", detail: res.fulltext.detail };
    return res;
  }
  const brief = fs.readFileSync(path.join(REPO, "perspectives", "_citations-judge.md"), "utf8").replace("<!-- tell-lint: off -->", "");
  const prompt = `${brief}\n\n---\n\n## Claim (from the article)\n\n${claim}\n\n## Source\n\n${describe(s)}\n\n${record?.abstract ? `### Abstract\n\n${record.abstract.slice(0, 3000)}\n\n` : ""}${passages.length ? `### Passages from the full text\n\n${passages.map((p, i) => `[${i + 1}] ${p}`).join("\n\n")}` : "### Passages from the full text\n\n(none: the full text could not be fetched)"}`;
  try {
    const j = (await claudeJson("citations-judge", prompt, JUDGE_SCHEMA, 180_000)) as { relevance: string; support: string; reason: string; passage: string };
    res.relevance = { status: j.relevance, detail: j.reason };
    let support = j.support;
    let verified: boolean | undefined;
    if (j.passage && full) {
      const m = matchQuote(j.passage, full.text);
      verified = m.status !== "not_found";
      if (!verified && (support === "supported" || support === "partly" || support === "not_supported")) support = "not_verified";
    }
    if (!passages.length && support !== "no_text") support = "no_text";
    res.support = {
      status: support,
      detail: support === "not_verified" ? `Claude’s quoted passage is not in the source, so its judgement (${j.support}) was set aside. ${j.reason}` : j.reason,
      passage: j.passage || undefined,
      passage_verified: verified,
    };
  } catch (e) {
    res.support = { status: "not_checked", detail: `Claude could not judge this one: ${(e as Error).message}` };
  }
  return res;
}

export interface ValidationSummary {
  notes: number;
  sources: number;
  problems: number;
}

export async function validateReferences(prof: Profile, draft: string, text: string, only?: string[]): Promise<ValidationSummary> {
  const st = readCiteState(draft);
  const cache = (st.parse_cache ?? {}) as Record<string, Segment[]>;
  const { defs } = parseNotes(text);
  const managed = defs.filter((d) => labelParts(d.label) && (!only || only.includes(d.label)));
  const parsed = await parseNotesWithClaude(managed.map((d) => ({ label: d.label, body: d.body })), cache);
  st.parse_cache = cache;
  const validation = (st.validation ?? {}) as Record<string, NoteValidation>;
  const lib = libraryDir(prof);
  let sources = 0;
  let problems = 0;
  const queue = [...parsed];
  const worker = async () => {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      const srcs = p.segments.filter((s) => s.kind === "citation").flatMap((s) => s.sources ?? []);
      if (!srcs.length) continue;
      const c = claimFor(text, p.label);
      const results: SourceResult[] = [];
      for (const s of srcs) {
        const r = await validateSource(prof, draft, p.label, s, c?.claim ?? "", st.links[suffixOf(p.label)] ?? null);
        results.push(r);
        sources++;
        if (isProblem(r)) problems++;
        const id = r.fulltext.library_id ?? (s.url ? (() => { try { return idForUrl(s.url!); } catch { return null; } })() : null);
        if (id) appendLog(lib, id, "validation", `${r.exists.status}; details ${r.details.status}; support ${r.support.status}`, r.support.detail.slice(0, 120));
      }
      validation[suffixOf(p.label)] = { claim: c?.claim ?? "", at: new Date().toISOString(), sources: results };
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  st.validation = validation;
  writeCiteState(draft, st);
  writeValidationComments(draft, text, validation, lib);
  return { notes: parsed.length, sources, problems };
}

function isProblem(r: SourceResult): boolean {
  return ["not_found"].includes(r.exists.status) || r.details.status === "differs" || ["not_relevant", "partly"].includes(r.relevance.status) || ["not_supported", "partly", "not_found_in_passages", "not_verified", "no_text"].includes(r.support.status);
}

const SUPPORT_TEXT: Record<string, string> = {
  supported: "supports the claim", partly: "only partly supports the claim", not_supported: "contradicts the claim",
  not_found_in_passages: "support not found in the passages checked", not_verified: "judgement set aside (passage not in source)", no_text: "not checked against the full text", not_checked: "not checked",
};

function writeValidationComments(draft: string, text: string, validation: Record<string, NoteValidation>, lib: string) {
  const sc = loadComments(draft, text);
  const { refs } = parseNotes(text);
  const now = new Date().toISOString();
  const cards: Comment[] = [];
  for (const [suf, v] of Object.entries(validation)) {
    const ref = refs.find((r) => suffixOf(r.label) === suf && !r.inDefinition);
    if (!ref) continue;
    v.sources.forEach((r, i) => {
      if (!isProblem(r)) return;
      const c = claimFor(text, ref.label);
      const start = c ? c.start : ref.start;
      const end = c ? c.end : ref.end;
      const where = locateBlock(text, start);
      const bits: string[] = [];
      if (r.exists.status === "not_found") bits.push(`Source not found: ${r.exists.detail}`);
      if (r.details.status === "differs") bits.push(`Details differ: ${r.details.diffs.join("; ")}`);
      if (r.relevance.status === "not_relevant" || r.relevance.status === "partly") bits.push(`Relevance: ${r.relevance.status.replace("_", " ")}.`);
      bits.push(`Support: ${SUPPORT_TEXT[r.support.status] ?? r.support.status}. ${r.support.detail}`);
      const severe = r.exists.status === "not_found" || r.support.status === "not_supported";
      const title = r.exists.status === "not_found" ? "Source could not be confirmed"
        : r.support.status === "not_supported" ? "Source contradicts the claim"
        : r.support.status === "partly" ? "Source only partly supports the claim"
        : r.details.status === "differs" ? "Citation details differ from the record"
        : r.support.status === "no_text" ? "Claim not checked against the source"
        : "Support not confirmed";
      cards.push({
        id: `cite-val-${suf}-${i}`, perspective: "citations", engine: "cite", run_id: `cite-val-${now.slice(0, 10)}`,
        level: "argument", severity: severe ? "should" : "consider", kind: "check",
        anchor: { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - 30), start), suffix: text.slice(end, end + 30), start, end, section: where.section, paragraph: where.paragraph },
        scope: "document", title: `${title} (${ref.label.replace(/-[a-z0-9]+$/, "")})`, rationale: bits.join(" "),
        hint: r.fulltext.status === "none" || r.support.status === "no_text" ? "Link the source file in the Citations tab, or check the claim against the source yourself." : "Check the claim against the source and correct the claim or the citation.",
        links: r.fulltext.library_id ? [{ label: "Saved source text", target: path.join(lib, "text", `${r.fulltext.library_id}.txt`), why: "The text the check used" }] : [],
        proposed_source: null, example: null, status: "open", dismiss_reason: null, stale: false, flags: ["cite"], created: now,
      });
    });
  }
  replaceCards(sc, (c) => c.engine === "cite" && c.id.startsWith("cite-val-"), cards);
  writeSidecar(draft, sc);
}
