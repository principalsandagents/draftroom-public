// Fetch a cited source and extract its text. Public URLs only: private, loopback and file
// addresses are refused at every redirect, and denylisted domains (paid newsletters, standards
// stores) are never fetched: those citations are leads, not sources.

import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { PANDOC } from "../docx/pandoc.ts";

export const MAX_BYTES = 25 * 1024 * 1024;
export const MIN_WORDS = 200;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Draftroom/0.1";

export const DEFAULT_DENIED_DOMAINS = [
  "exponentialview.co", "wheresyoured.at", "iso.org", "iec.ch", "standards.org.au", "store.standards.org.au", "saiglobal.com", "techstreet.com",
];

export type FetchKind = "pdf" | "html" | "text";
export interface PageMeta {
  title?: string; // cleaned of " | Site" suffixes
  site?: string;
  published?: string; // ISO date
  authors?: string[];
  doi?: string;
}

/** Citation metadata a page declares about itself (Highwire/citation_*, Open Graph, article:*, JSON-LD). */
export function pageMeta(html: string, host = ""): PageMeta {
  const meta = (names: string[]): string[] => {
    const out: string[] = [];
    for (const n of names) {
      const re = new RegExp(`<meta[^>]+(?:name|property)=["']${n.replace(/[.:]/g, "\\$&")}["'][^>]*>`, "gi");
      for (const m of html.matchAll(re)) {
        const c = /content=["']([^"']*)["']/i.exec(m[0]);
        if (c && c[1].trim()) out.push(c[1].trim());
      }
    }
    return out;
  };
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  const site = meta(["og:site_name", "citation_journal_title", "application-name"])[0];
  let title = meta(["citation_title", "og:title", "twitter:title"])[0] ?? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  title = decode(title);
  const siteName = site ? decode(site) : undefined;
  // Drop a trailing " | Site", " - Site" or " — Site" only when that part names the site.
  const parts = title.split(/\s+[|–—-]\s+/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    const brand = host.replace(/^www\./, "").split(".")[0].toLowerCase();
    const names = [siteName?.toLowerCase(), brand].filter((x): x is string => !!x && x.length > 2);
    if (names.some((n) => last.includes(n) || n.includes(last))) title = title.slice(0, title.length - parts[parts.length - 1].length).replace(/\s+[|–—-]\s*$/, "");
  }
  const authors = meta(["citation_author", "author", "article:author", "parsely-author", "sailthru.author"]).map(decode).filter((a) => a && !/^https?:/.test(a) && a.length < 80);
  const published = meta(["citation_publication_date", "citation_date", "article:published_time", "og:published_time", "date", "parsely-pub-date", "dc.date"])[0];
  const doi = meta(["citation_doi", "dc.identifier"]).find((x) => /^10\.\d+\//.test(x.replace(/^doi:/i, "")));
  return { title: title || undefined, site: siteName, published: published?.slice(0, 10).replace(/\//g, "-"), authors: authors.length ? [...new Set(authors)] : undefined, doi: doi?.replace(/^doi:/i, "") };
}

export interface Fetched {
  ok: true;
  finalUrl: string;
  kind: FetchKind;
  bytes: Buffer;
  text: string;
  title: string;
  words: number;
  meta: PageMeta;
}
export interface NotFetched {
  ok: false;
  reason: string; // shown to the writer
  denied?: boolean;
}

function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

export function deniedDomain(host: string, denied: string[]): string | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  return denied.find((d) => h === d || h.endsWith(`.${d}`)) ?? null;
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
let resolveImpl: (host: string) => Promise<string[]> = async (h) => (await dns.lookup(h, { all: true })).map((x) => x.address);
export function setFetchForTests(f: Fetch | null, resolver?: (h: string) => Promise<string[]>) {
  fetchImpl = f ?? ((...a) => fetch(...a));
  if (resolver) resolveImpl = resolver;
  else if (!f) resolveImpl = async (h) => (await dns.lookup(h, { all: true })).map((x) => x.address);
}

async function checkUrl(u: URL, denied: string[]): Promise<string | null> {
  if (u.protocol !== "https:" && u.protocol !== "http:") return `only web addresses can be fetched (${u.protocol})`;
  const d = deniedDomain(u.hostname, denied);
  if (d) return `${d} is a paid or licensed source: treat it as a lead and cite the primary source`;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : await resolveImpl(host).catch(() => []);
  if (!ips.length) return `could not find ${u.hostname}`;
  if (ips.some(privateIp)) return "refused: the address points inside this computer or network";
  return null;
}

function run(cmd: string, args: string[], input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => p.kill("SIGTERM"), 60_000);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (c) => { clearTimeout(t); c === 0 ? resolve(out) : reject(new Error(err.slice(0, 200) || `${cmd} exited ${c}`)); });
    p.stdin.end(input);
  });
}

export const PDFTOTEXT = process.env.DRAFTROOM_PDFTOTEXT ?? "pdftotext";

/** Plain text from a PDF (reading order, no -layout so columns do not interleave). */
export function pdfText(bytes: Buffer): Promise<string> {
  return run(PDFTOTEXT, ["-enc", "UTF-8", "-", "-"], bytes);
}

/** Plain text from HTML: scripts, styles, navigation, headers, footers and forms removed first. */
export async function htmlText(html: string): Promise<{ text: string; title: string }> {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? html;
  const cleaned = main.replace(/<(script|style|nav|header|footer|aside|form|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const text = await run(PANDOC, ["-f", "html", "-t", "plain", "--wrap=none"], Buffer.from(cleaned));
  return { text, title };
}

export function docxText(bytes: Buffer): Promise<string> {
  return run(PANDOC, ["-f", "docx", "-t", "plain", "--wrap=none"], bytes);
}

export function wordCount(t: string): number {
  return (t.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export async function fetchSource(raw: string, denied: string[] = DEFAULT_DENIED_DOMAINS): Promise<Fetched | NotFetched> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid web address" };
  }
  for (let hop = 0; hop < 6; hop++) {
    const bad = await checkUrl(url, denied);
    if (bad) return { ok: false, reason: bad, denied: /paid or licensed/.test(bad) };
    let r: Response;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    try {
      r = await fetchImpl(url, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" }, signal: ctl.signal });
    } catch (e) {
      clearTimeout(t);
      return { ok: false, reason: (e as Error).name === "AbortError" ? "the source did not answer within 20 seconds" : `could not reach the source (${(e as Error).message})` };
    }
    clearTimeout(t);
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      url = new URL(r.headers.get("location")!, url);
      continue;
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: `the source refused access (HTTP ${r.status}); it may be paywalled or block automated reading` };
    if (!r.ok) return { ok: false, reason: `the source answered HTTP ${r.status}` };
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return { ok: false, reason: "the source is larger than 25 MB" };
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { ok: false, reason: "the source is larger than 25 MB" };
    const type = (r.headers.get("content-type") ?? "").toLowerCase();
    let kind: FetchKind;
    let text: string;
    let title = "";
    let meta: PageMeta = {};
    if (type.includes("pdf") || bytes.subarray(0, 5).toString() === "%PDF-") {
      kind = "pdf";
      text = await pdfText(bytes).catch(() => "");
    } else if (type.includes("html") || /^\s*<(!doctype|html)/i.test(bytes.subarray(0, 200).toString())) {
      kind = "html";
      const html = bytes.toString("utf8");
      ({ text, title } = await htmlText(html).catch(() => ({ text: "", title: "" })));
      meta = pageMeta(html, url.hostname);
      if (meta.title) title = meta.title;
    } else {
      kind = "text";
      text = bytes.toString("utf8");
    }
    const words = wordCount(text);
    if (words < MIN_WORDS) return { ok: false, reason: `only ${words} words could be read: the page may need a browser to load, or be blocked` };
    return { ok: true, finalUrl: url.toString(), kind, bytes, text, title, words, meta };
  }
  return { ok: false, reason: "too many redirects" };
}
