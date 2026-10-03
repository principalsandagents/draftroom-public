// Citation formatting with citeproc-js (the CSL engine Zotero uses). Deterministic: the same
// items in the same order always give the same notes. Footnotes and endnotes are separate
// streams, each with its own registry, so "(n X)" and ibid never point across streams.

import fs from "node:fs";
import path from "node:path";
import CSL from "citeproc";

export type NoteStyle = "aglc4" | "chicago18";
export type StyleId = NoteStyle | "apa7";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "styles");
const STYLE_LOCALE: Record<StyleId, string> = { aglc4: "en-GB", chicago18: "en-US", apa7: "en-US" };

export interface CslItem {
  id: string;
  type: string;
  title?: string;
  author?: Array<{ family?: string; given?: string; literal?: string }>;
  "container-title"?: string;
  publisher?: string;
  "publisher-place"?: string;
  issued?: { "date-parts": number[][] };
  accessed?: { "date-parts": number[][] };
  URL?: string;
  DOI?: string;
  page?: string;
  volume?: string;
  issue?: string;
  number?: string;
  genre?: string;
  authority?: string;
  medium?: string;
  [k: string]: unknown;
}

export interface CiteRef {
  id: string; // item id
  locator?: string;
  label?: string; // "page", "paragraph", "section" …
  prefix?: string;
  suffix?: string;
}

export interface NoteCluster {
  key: string; // unique per cluster: `${noteLabel}#${segmentIndex}`
  noteNumber: number; // within its stream
  refs: CiteRef[];
}

function locale(lang: string): string {
  return fs.readFileSync(path.join(DIR, `locales-${lang}.xml`), "utf8");
}

export function styleXml(style: StyleId): string {
  return fs.readFileSync(path.join(DIR, `${style}.csl`), "utf8");
}

/** citeproc HTML to markdown: italics and bold kept, everything else as text. */
export function htmlToMd(html: string): string {
  return html
    .replace(/<i>(.*?)<\/i>/g, "*$1*")
    .replace(/<span style="font-style:\s*italic;?">(.*?)<\/span>/g, "*$1*")
    .replace(/<b>(.*?)<\/b>/g, "**$1**")
    .replace(/<span style="font-variant:\s*small-caps;?">(.*?)<\/span>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#38;|&amp;/g, "&")
    .replace(/&#60;|&lt;/g, "<")
    .replace(/&#62;|&gt;/g, ">")
    .replace(/&#39;|&#x27;/g, "’")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\*\*\*/g, "*")
    .trim();
}

function engineFor(style: StyleId, items: Record<string, CslItem>) {
  const lang = STYLE_LOCALE[style];
  const sys = {
    retrieveLocale: (l: string) => (l.startsWith("en-GB") || l === "en-AU" ? locale("en-GB") : locale("en-US")),
    retrieveItem: (id: string) => items[id],
  };
  const eng = new (CSL as any).Engine(sys, styleXml(style), lang, true);
  eng.setOutputFormat("html");
  return eng;
}

/**
 * Render note clusters in reading order for one stream. Returns the formatted text per cluster
 * key, with position forms (subsequent, ibid) decided by citeproc from the order and note numbers.
 */
export function renderStream(style: NoteStyle, items: Record<string, CslItem>, clusters: NoteCluster[]): Record<string, string> {
  if (!clusters.length) return {};
  const eng = engineFor(style, items);
  const citations = clusters.map((c) => ({
    citationID: c.key,
    citationItems: c.refs.map((r) => ({ id: r.id, ...(r.locator ? { locator: r.locator, label: r.label ?? "page" } : {}), ...(r.prefix ? { prefix: r.prefix } : {}), ...(r.suffix ? { suffix: r.suffix } : {}) })),
    properties: { noteIndex: c.noteNumber },
  }));
  const out: Record<string, string> = {};
  const rebuilt: Array<[string, number, string]> = eng.rebuildProcessorState(citations, "html", []);
  for (const [id, , html] of rebuilt) out[id] = htmlToMd(html);
  return out;
}

/** APA (Release D): in-text strings and the reference list. */
export function renderApa(items: Record<string, CslItem>, clusters: NoteCluster[]): { inText: Record<string, string>; references: string[] } {
  const eng = engineFor("apa7", items);
  const citations = clusters.map((c, i) => ({ citationID: c.key, citationItems: c.refs.map((r) => ({ id: r.id, ...(r.locator ? { locator: r.locator, label: r.label ?? "page" } : {}) })), properties: { noteIndex: i + 1 } }));
  const inText: Record<string, string> = {};
  for (const [id, , html] of eng.rebuildProcessorState(citations, "html", []) as Array<[string, number, string]>) inText[id] = htmlToMd(html);
  eng.updateItems(Object.keys(items));
  const bib = eng.makeBibliography();
  const references = bib ? (bib[1] as string[]).map(htmlToMd) : [];
  return { inText, references };
}
