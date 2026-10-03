// The shared reference library : <library_dir>/
//   cards/<id>.md      tracked: source metadata and a verification log (no draft names)
//   files/<id>.<ext>   private (gitignored): fetched page or PDF, or a linked upload
//   text/<id>.txt      private (gitignored): extracted text
//   index/cited-by.json private (gitignored): which drafts cite which sources

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface LibraryEntry {
  id: string;
  file: string;
  text: string;
  card: string;
}

function slug(s: string, n = 6): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, n).join("-") || "source";
}

export function sha1(b: Buffer | string): string {
  return crypto.createHash("sha1").update(b).digest("hex");
}

/** A stable id for a URL: host and path words plus a short hash of the normalised URL. */
export function idForUrl(url: string): string {
  const u = new URL(url);
  const norm = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  return `${slug(`${u.hostname.replace(/^www\./, "").split(".")[0]} ${u.pathname}`, 7)}-${sha1(norm).slice(0, 6)}`;
}

export function idForUpload(name: string, bytes: Buffer): string {
  return `linked-${slug(name.replace(/\.[a-z0-9]+$/i, ""), 6)}-${sha1(bytes).slice(0, 6)}`;
}

export function ensureLibrary(dir: string) {
  for (const sub of ["cards", "files", "text", "index"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
}

export function entryPaths(dir: string, id: string, ext = "bin"): LibraryEntry {
  return { id, file: path.join(dir, "files", `${id}.${ext}`), text: path.join(dir, "text", `${id}.txt`), card: path.join(dir, "cards", `${id}.md`) };
}

export function existingText(dir: string, id: string): string | null {
  const p = path.join(dir, "text", `${id}.txt`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

export interface SaveMeta {
  origin: "fetched" | "linked";
  url?: string;
  finalUrl?: string;
  title?: string;
  originalName?: string;
  kind: string;
  site?: string;
  published?: string;
  authors?: string[];
  doi?: string;
}

/** Save a source's bytes and text, and create or update its record card. */
export function saveSource(dir: string, id: string, ext: string, bytes: Buffer, text: string, meta: SaveMeta): LibraryEntry {
  ensureLibrary(dir);
  const e = entryPaths(dir, id, ext);
  fs.writeFileSync(e.file, bytes, { mode: 0o600 });
  fs.writeFileSync(e.text, text, { mode: 0o600 });
  const today = new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(e.card)) {
    const fm = [
      "---",
      `id: ${id}`,
      `origin: ${meta.origin}`,
      meta.url ? `url: ${JSON.stringify(meta.url)}` : null,
      meta.finalUrl && meta.finalUrl !== meta.url ? `final_url: ${JSON.stringify(meta.finalUrl)}` : null,
      meta.title ? `title: ${JSON.stringify(meta.title)}` : null,
      meta.originalName ? `file_name: ${JSON.stringify(meta.originalName)}` : null,
      meta.site ? `site: ${JSON.stringify(meta.site)}` : null,
      meta.published ? `published: ${JSON.stringify(meta.published)}` : null,
      meta.authors?.length ? `authors: ${JSON.stringify(meta.authors)}` : null,
      meta.doi ? `doi: ${JSON.stringify(meta.doi)}` : null,
      `kind: ${meta.kind}`,
      `saved: ${today}`,
      `sha1: ${sha1(bytes)}`,
      "---",
      "",
      `# ${meta.title || meta.originalName || meta.url || id}`,
      "",
      "The source file and its text are kept privately in `files/` and `text/` (gitignored). This card records what was checked against it.",
      "",
      "## Verification log",
      "",
      "| Date | Check | Result | Detail |",
      "| --- | --- | --- | --- |",
      "",
    ].filter((x) => x !== null).join("\n");
    fs.writeFileSync(e.card, fm);
  }
  return e;
}

/** Metadata recorded on a source's card. */
export function cardMeta(dir: string, id: string): { title?: string; site?: string; published?: string; authors?: string[]; doi?: string; url?: string } | null {
  const p = path.join(dir, "cards", `${id}.md`);
  if (!fs.existsSync(p)) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(p, "utf8"))?.[1] ?? "";
  const get = (k: string) => {
    const m = new RegExp(`^${k}: (.+)$`, "m").exec(fm);
    if (!m) return undefined;
    try { return JSON.parse(m[1]); } catch { return m[1]; }
  };
  return { title: get("title"), site: get("site"), published: get("published"), authors: get("authors"), doi: get("doi"), url: get("url") };
}

export function appendLog(dir: string, id: string, check: string, result: string, detail: string) {
  const card = path.join(dir, "cards", `${id}.md`);
  if (!fs.existsSync(card)) return;
  const clean = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  fs.appendFileSync(card, `| ${new Date().toISOString().slice(0, 10)} | ${clean(check)} | ${clean(result)} | ${clean(detail)} |\n`);
}

export function noteCitedBy(dir: string, id: string, draft: string) {
  ensureLibrary(dir);
  const p = path.join(dir, "index", "cited-by.json");
  let idx: Record<string, string[]> = {};
  try {
    idx = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* new */
  }
  idx[id] = [...new Set([...(idx[id] ?? []), draft])];
  fs.writeFileSync(p, JSON.stringify(idx, null, 1), { mode: 0o600 });
}
