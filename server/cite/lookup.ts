// Scholarly lookups: Crossref (does it exist, what are its details), OpenAlex (abstract,
// open-access links), Unpaywall (best open-access copy). The profile's contact email goes to these
// three hosts only (his consent, 2026-10-03). Only the DOI or the title, authors and year
// being looked up are sent; never draft text.

import { norm, type ParsedSource } from "./parse.ts";

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setLookupFetch(f: Fetch | null) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

const lastCall = new Map<string, number>();
async function polite(url: string, email: string | undefined): Promise<any | null> {
  const host = new URL(url).hostname;
  const wait = (lastCall.get(host) ?? 0) + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(host, Date.now());
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetchImpl(url, { headers: { "user-agent": `Draftroom/0.1${email ? ` (mailto:${email})` : ""}`, accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface LookupRecord {
  source: "crossref" | "openalex";
  title: string;
  authors: string[]; // family names, or organisation names
  year?: number;
  container?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  oaUrl?: string;
  similarity: number;
}

/** Title similarity on normalised titles with subtitles stripped (Dice coefficient on words). */
export function titleSimilarity(a: string, b: string): number {
  const clean = (s: string) => norm(s).split(/[:?]\s/)[0].replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2);
  const A = clean(a);
  const B = clean(b);
  if (!A.length || !B.length) return 0;
  const sb = new Set(B);
  const inter = A.filter((w) => sb.has(w)).length;
  return (2 * inter) / (A.length + B.length);
}

function crossrefToRecord(m: any, want?: ParsedSource): LookupRecord {
  const title = (m.title?.[0] ?? "") as string;
  return {
    source: "crossref",
    title,
    authors: (m.author ?? []).map((a: any) => a.family ?? a.name).filter(Boolean),
    year: m.issued?.["date-parts"]?.[0]?.[0] ?? m.published?.["date-parts"]?.[0]?.[0],
    container: m["container-title"]?.[0],
    volume: m.volume,
    issue: m.issue,
    pages: m.page,
    doi: m.DOI,
    url: m.URL,
    similarity: want?.title ? titleSimilarity(want.title, title) : 1,
  };
}

export async function crossref(s: ParsedSource, email?: string): Promise<LookupRecord | null> {
  if (s.doi) {
    const j = await polite(`https://api.crossref.org/works/${encodeURIComponent(s.doi)}${email ? `?mailto=${encodeURIComponent(email)}` : ""}`, email);
    return j?.message ? crossrefToRecord(j.message, s) : null;
  }
  if (!s.title) return null;
  const q = [s.title, s.authors?.[0]?.family ?? s.authors?.[0]?.literal, s.year].filter(Boolean).join(" ");
  const j = await polite(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=5${email ? `&mailto=${encodeURIComponent(email)}` : ""}`, email);
  const cands: LookupRecord[] = (j?.message?.items ?? []).map((m: any) => crossrefToRecord(m, s));
  const ok = cands.filter((c) => c.similarity >= 0.9 && (!s.year || !c.year || Math.abs(c.year - s.year) <= 1));
  return ok.sort((a, b) => b.similarity - a.similarity)[0] ?? null;
}

/** OpenAlex stores abstracts as an inverted index: word -> positions. */
export function invertedToText(idx: { [w: string]: number[] } | null | undefined): string | undefined {
  if (!idx) return undefined;
  const words: string[] = [];
  for (const [w, ps] of Object.entries(idx)) for (const p of ps) words[p] = w;
  return words.filter(Boolean).join(" ") || undefined;
}

export async function openalex(s: ParsedSource, doi: string | undefined, email?: string): Promise<LookupRecord | null> {
  const mail = email ? `mailto=${encodeURIComponent(email)}` : "";
  let w: any = null;
  if (doi) w = await polite(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}${mail ? `?${mail}` : ""}`, email);
  else if (s.title) {
    const j = await polite(`https://api.openalex.org/works?search=${encodeURIComponent(s.title)}&per-page=5${mail ? `&${mail}` : ""}`, email);
    const best = (j?.results ?? []).map((r: any) => ({ r, sim: titleSimilarity(s.title!, r.display_name ?? r.title ?? "") })).filter((x: any) => x.sim >= 0.9 && (!s.year || !x.r.publication_year || Math.abs(x.r.publication_year - s.year) <= 1)).sort((a: any, b: any) => b.sim - a.sim)[0];
    w = best?.r ?? null;
  }
  if (!w) return null;
  return {
    source: "openalex",
    title: w.display_name ?? w.title ?? "",
    authors: (w.authorships ?? []).map((a: any) => (a.author?.display_name ?? "").split(" ").pop()).filter(Boolean),
    year: w.publication_year,
    container: w.primary_location?.source?.display_name,
    doi: w.doi?.replace(/^https:\/\/doi\.org\//, ""),
    abstract: invertedToText(w.abstract_inverted_index),
    oaUrl: w.best_oa_location?.pdf_url ?? w.best_oa_location?.landing_page_url ?? w.open_access?.oa_url ?? undefined,
    similarity: s.title ? titleSimilarity(s.title, w.display_name ?? w.title ?? "") : 1,
  };
}

export async function unpaywall(doi: string, email: string | undefined): Promise<string | null> {
  if (!email) return null; // Unpaywall requires a contact email
  const j = await polite(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, email);
  const loc = j?.best_oa_location;
  return loc?.url_for_pdf ?? loc?.url ?? null;
}

/** Differences between what the note says and the record, for the details check. */
export function compareDetails(s: ParsedSource, r: LookupRecord): string[] {
  const diffs: string[] = [];
  if (s.title && r.title && titleSimilarity(s.title, r.title) < 0.9) diffs.push(`title in note “${s.title}”, record “${r.title}”`);
  if (s.year && r.year && s.year !== r.year) diffs.push(`year in note ${s.year}, ${r.source} ${r.year}`);
  const fam = (s.authors ?? []).map((a) => norm(a.family ?? a.literal ?? "")).filter(Boolean);
  const rec = r.authors.map((a) => norm(a));
  const missing = fam.filter((f) => !rec.some((x) => x.includes(f) || f.includes(x)));
  if (fam.length && rec.length && missing.length) diffs.push(`author${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not in the ${r.source} record (${r.authors.slice(0, 4).join(", ")})`);
  if (s.container && r.container && titleSimilarity(s.container, r.container) < 0.8) diffs.push(`published in “${s.container}” per note, “${r.container}” per ${r.source}`);
  if (s.volume && r.volume && s.volume !== r.volume) diffs.push(`volume ${s.volume} in note, ${r.volume} in record`);
  if (s.doi && r.doi && s.doi.toLowerCase() !== r.doi.toLowerCase()) diffs.push(`DOI ${s.doi} in note, ${r.doi} in record`);
  return diffs;
}
