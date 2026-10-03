// Word (.docx) to markdown.
//
// Pandoc parses the docx (headers, footers and page numbers are never part of its body model).
// Draftroom then cleans the AST and adds what pandoc does not keep:
// - footnote versus endnote, recovered from the reference order in word/document.xml
// - stable note labels: [^FN01-k3x9], [^EN07-p2qa] (markdown footnotes link both ways)
// - content images saved as images/<stem>-fig01-<hash>.<ext>, referenced in place with a FIG id
// - Word comments moved into the Draftroom sidecar, anchored to the commented text
// - table-of-contents entries, bookmarks, highlight and style wrappers removed;
//   tracked insertions accepted, deletions dropped

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";
import YAML from "yaml";
import { runPandoc, stringify, attrOf, str, EMPTY_ATTR, gridRanges, outsideGrids, type Node } from "./pandoc.ts";

export interface ImportedComment {
  author: string;
  date: string;
  text: string;
  start: number; // offsets in the final markdown
  end: number;
  exact: string;
}

export interface ImportReport {
  markdownPath: string;
  headings: number;
  paragraphs: number;
  tables: { pipe: number; grid: number; html: number };
  images: Array<{ id: string; file: string; alt: string }>;
  footnotes: number;
  endnotes: number;
  comments: number;
  removed: { tocEntries: number; trackedDeletions: number; emptyParagraphs: number; bookmarks: number };
  noteKindSource: "document-order" | "reference-style" | "default";
  warnings: string[];
}

export interface ImportResult {
  markdown: string;
  comments: ImportedComment[];
  report: ImportReport;
}

// Private-use sentinels survive pandoc's markdown writer untouched.
const NOTE_OPEN = "";
const NOTE_CLOSE = "";
const C_START = ["", ""];
const C_END = ["", ""];

const TOC_STYLE = /^(toc\s*\d+|toc heading|table of figures|tof\s*\d*)$/i;
const CAPTION_STYLE = /caption/i;
const META_STYLE: Record<string, string> = { title: "title", subtitle: "subtitle", author: "author", date: "date", abstract: "abstract" };
const BROWSER_IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function shortHash(s: string | Buffer, n = 4): string {
  const h = crypto.createHash("sha1").update(s).digest();
  let out = "";
  for (let i = 0; out.length < n; i++) out += (h[i] % 36).toString(36);
  return out;
}

export function slugify(name: string): string {
  return name
    .replace(/\.docx$/i, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "imported";
}

/** Footnote and endnote references in body order. mc:Fallback copies are removed first. */
export async function noteOrder(zip: JSZip): Promise<Array<"FN" | "EN">> {
  const doc = await zip.file("word/document.xml")?.async("string");
  if (!doc) return [];
  const clean = doc.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  const out: Array<"FN" | "EN"> = [];
  for (const m of clean.matchAll(/<w:(footnote|endnote)Reference\b/g)) out.push(m[1] === "footnote" ? "FN" : "EN");
  return out;
}

interface Ctx {
  report: ImportReport;
  notes: Array<{ kind: "FN" | "EN" | null; text: string; dropped?: boolean }>;
  comments: Map<string, { author: string; date: string; text: string }>;
  images: Map<string, { id: string; file: string; alt: string }>; // by media path
  imageHashes: Map<string, string>; // content hash -> file name
  mediaRoot: string;
  imagesDir: string;
  stem: string;
  figCount: number;
  meta: Record<string, string>; // Title, Subtitle, Author, Date paragraphs found in the body
}

const isBlank = (inl: any[]) => inl.every((x) => x.t === "Space" || x.t === "SoftBreak" || x.t === "LineBreak" || (x.t === "Str" && !x.c.trim()));

// ---------------------------------------------------------------- inline cleaning

function cleanInlines(inl: any[], ctx: Ctx): any[] {
  const out: any[] = [];
  for (const x of inl) out.push(...cleanInline(x, ctx));
  return out;
}

function cleanInline(x: any, ctx: Ctx): any[] {
  switch (x.t) {
    case "Span": {
      const a = attrOf(x)!;
      if (a.classes.includes("comment-start")) {
        const id = a.id || a.kv.id || String(ctx.comments.size);
        ctx.comments.set(id, { author: a.kv.author ?? "", date: a.kv.date ?? "", text: stringify(x.c[1]).replace(/\s+/g, " ").trim() });
        return [str(`${C_START[0]}${id}${C_START[1]}`)];
      }
      if (a.classes.includes("comment-end")) {
        const id = a.id || a.kv.id || "";
        return [str(`${C_END[0]}${id}${C_END[1]}`)];
      }
      if (a.classes.includes("deletion")) {
        ctx.report.removed.trackedDeletions++;
        // Count notes inside deleted text so the document-order mapping stays aligned.
        countNotes(x.c[1], ctx);
        return [];
      }
      if (a.classes.includes("paragraph-insertion") || a.classes.includes("paragraph-deletion")) return [];
      if (a.id && !a.classes.length && !Object.keys(a.kv).length) ctx.report.removed.bookmarks++;
      return cleanInlines(x.c[1], ctx); // insertion, anchor, mark, custom-style: keep the text only
    }
    case "Note": {
      const idx = ctx.notes.length;
      ctx.notes.push({ kind: null, text: "" });
      const blocks = cleanBlocks(x.c, ctx);
      ctx.notes[idx].text = stringify(blocks).trim();
      const marker = str(`${NOTE_OPEN}${idx}${NOTE_CLOSE}`);
      const first = blocks.find((b: any) => b.t === "Para" || b.t === "Plain");
      if (first) first.c.unshift(marker);
      else blocks.unshift({ t: "Plain", c: [marker] });
      return [{ t: "Note", c: blocks }];
    }
    case "Link": {
      const target: string = x.c[2][0];
      const inner = cleanInlines(x.c[1], ctx);
      // Internal links to Word bookmarks (_Toc, _Ref, _Hlk) point at anchors that no longer exist.
      if (target.startsWith("#")) return inner;
      // A link whose text is its own URL is written as an autolink: <https://…>.
      const plain = stringify(inner).trim();
      const isUri = plain === target || `mailto:${plain}` === target;
      return [{ t: "Link", c: [isUri ? ["", ["uri"], []] : EMPTY_ATTR, inner, x.c[2]] }];
    }
    case "Image":
      return [imageNode(x, ctx)];
    case "Underline":
    case "SmallCaps":
      return cleanInlines(x.c, ctx);
    case "Code":
      // Word runs in a monospaced font arrive as inline code; in prose they are formatting only.
      return [str(x.c[1])];
    case "Emph":
    case "Strong":
    case "Strikeout":
    case "Superscript":
    case "Subscript": {
      const inner = cleanInlines(x.c, ctx);
      return isBlank(inner) ? inner : [{ t: x.t, c: inner }];
    }
    case "Quoted":
      return [{ t: "Quoted", c: [x.c[0], cleanInlines(x.c[1], ctx)] }];
    case "Cite":
      return cleanInlines(x.c[1], ctx);
    default:
      return [x];
  }
}

function countNotes(inl: any, ctx: Ctx) {
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.t === "Note") {
      // A note inside deleted text or a contents entry: kept in the order so the mapping to
      // document.xml stays aligned, but never labelled or counted.
      ctx.notes.push({ kind: null, text: "", dropped: true });
      return;
    }
    if (n.c) walk(n.c);
  };
  walk(inl);
}

function imageNode(x: any, ctx: Ctx): any {
  const src: string = x.c[2][0];
  // Word's machine alt text ("A picture containing text Description automatically generated") is noise.
  const alt = stringify(x.c[1]).replace(/\s*Description automatically generated\.?\s*$/i, "").replace(/\s+/g, " ").trim();
  let rec = ctx.images.get(src);
  if (!rec) {
    const abs = path.isAbsolute(src) ? src : path.join(ctx.mediaRoot, src);
    if (!fs.existsSync(abs)) {
      ctx.report.warnings.push(`image not extracted: ${src}`);
      return str(`[image missing: ${path.basename(src)}]`);
    }
    const bytes = fs.readFileSync(abs);
    const hash = shortHash(bytes, 6);
    const ext = path.extname(abs).toLowerCase() || ".bin";
    let file = ctx.imageHashes.get(hash);
    ctx.figCount++;
    const num = String(ctx.figCount).padStart(2, "0");
    if (!file) {
      file = `${ctx.stem}-fig${num}-${hash}${ext}`;
      fs.mkdirSync(ctx.imagesDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.imagesDir, file), bytes);
      ctx.imageHashes.set(hash, file);
      if (!BROWSER_IMAGE.test(ext)) ctx.report.warnings.push(`${file}: ${ext} images do not display in browsers; convert it to PNG if you need to see it`);
    }
    rec = { id: `FIG${num}-${hash.slice(0, 4)}`, file, alt };
    ctx.images.set(src, rec);
    ctx.report.images.push(rec);
  }
  return { t: "Image", c: [EMPTY_ATTR, alt ? [str(alt)] : [], [`images/${rec.file}`, rec.id]] };
}

// ---------------------------------------------------------------- block cleaning

const CAPTION = Symbol("caption");

function cleanBlocks(blocks: any[], ctx: Ctx): any[] {
  const out: any[] = [];
  for (const b of blocks) out.push(...cleanBlock(b, ctx));
  return attachCaptions(out);
}

function cleanBlock(b: any, ctx: Ctx): any[] {
  switch (b.t) {
    case "Div": {
      const a = attrOf(b)!;
      const style = a.kv["custom-style"] ?? "";
      const metaKey = META_STYLE[style.toLowerCase()];
      if (metaKey) {
        // Pandoc lifts these into metadata only at the very start; catch them anywhere.
        const text = stringify(b.c[1]).replace(/\s+/g, " ").trim();
        if (text && !ctx.meta[metaKey]) ctx.meta[metaKey] = text;
        return [];
      }
      if (TOC_STYLE.test(style)) {
        ctx.report.removed.tocEntries++;
        countNotes(b.c[1], ctx);
        return [];
      }
      const inner = cleanBlocks(b.c[1], ctx);
      if (CAPTION_STYLE.test(style)) for (const x of inner) (x as any)[CAPTION] = true;
      return inner;
    }
    case "Para":
    case "Plain": {
      const inl = cleanInlines(b.c, ctx);
      if (isBlank(inl)) {
        ctx.report.removed.emptyParagraphs++;
        return [];
      }
      ctx.report.paragraphs++;
      return [{ t: b.t, c: trimInlines(inl) }];
    }
    case "Header": {
      const inl = cleanInlines(b.c[2], ctx);
      if (isBlank(inl)) return [];
      ctx.report.headings++;
      return [{ t: "Header", c: [b.c[0], EMPTY_ATTR, trimInlines(inl)] }];
    }
    case "BlockQuote":
      return [{ t: "BlockQuote", c: cleanBlocks(b.c, ctx) }];
    case "BulletList":
      return [{ t: "BulletList", c: b.c.map((item: any[]) => cleanBlocks(item, ctx)) }];
    case "OrderedList":
      return [{ t: "OrderedList", c: [b.c[0], b.c[1].map((item: any[]) => cleanBlocks(item, ctx))] }];
    case "DefinitionList":
      return [{ t: "DefinitionList", c: b.c.map(([term, defs]: any) => [cleanInlines(term, ctx), defs.map((d: any[]) => cleanBlocks(d, ctx))]) }];
    case "Table":
      return [cleanTable(b, ctx)];
    case "Figure": {
      // [attr, caption, blocks]: back to ![caption](image), which exports as a captioned figure.
      const caption = cleanBlocks(b.c[1][1], ctx).flatMap((x: any) => (x.t === "Para" || x.t === "Plain" ? x.c : []));
      const inner = cleanBlocks(b.c[2], ctx);
      const imgs = inner.flatMap((x: any) => (x.t === "Para" || x.t === "Plain" ? x.c.filter((i: any) => i.t === "Image") : []));
      if (imgs.length === 1 && caption.length) {
        imgs[0].c[1] = caption;
        return [{ t: "Para", c: [imgs[0]] }];
      }
      return [...inner, ...(caption.length ? [{ t: "Para", c: caption }] : [])];
    }
    case "HorizontalRule":
    case "CodeBlock":
    case "RawBlock":
      return [b];
    case "LineBlock":
      return [{ t: "LineBlock", c: b.c.map((l: any[]) => cleanInlines(l, ctx)) }];
    default:
      return [b];
  }
}

function trimInlines(inl: any[]): any[] {
  let s = 0;
  let e = inl.length;
  while (s < e && ["Space", "SoftBreak", "LineBreak"].includes(inl[s].t)) s++;
  while (e > s && ["Space", "SoftBreak", "LineBreak"].includes(inl[e - 1].t)) e--;
  return inl.slice(s, e);
}

function cleanTable(t: any, ctx: Ctx): any {
  // Table: [attr, caption, colspecs, head, bodies, foot]. Clean every cell's blocks.
  const fixCell = (c: any) => {
    // Cell: [attr, alignment, rowspan, colspan, blocks]
    return [EMPTY_ATTR, c[1], c[2], c[3], cleanBlocks(c[4], ctx)];
  };
  const row = (r: any) => [EMPTY_ATTR, r[1].map(fixCell)];
  const [, caption, colspecs, head, bodies, foot] = t.c;
  return {
    t: "Table",
    c: [
      EMPTY_ATTR,
      [caption[0], cleanBlocks(caption[1], ctx)],
      colspecs,
      [EMPTY_ATTR, head[1].map(row)],
      bodies.map((b: any) => [EMPTY_ATTR, b[1], b[2].map(row), b[3].map(row)]),
      [EMPTY_ATTR, foot[1].map(row)],
    ],
  };
}

/** An image alone in a paragraph next to a Caption-styled paragraph takes it as its caption. */
function attachCaptions(blocks: any[]): any[] {
  const isImagePara = (b: any) => (b?.t === "Para" || b?.t === "Plain") && b.c.length === 1 && b.c[0].t === "Image";
  const out = [...blocks];
  for (let i = 0; i < out.length; i++) {
    if (!isImagePara(out[i])) continue;
    for (const j of [i + 1, i - 1]) {
      const cap = out[j];
      if (cap && (cap as any)[CAPTION] && (cap.t === "Para" || cap.t === "Plain")) {
        const img = out[i].c[0];
        img.c[1] = cap.c; // caption becomes the alt text, which pandoc exports as the figure caption
        out[i] = { t: "Para", c: [img] };
        out.splice(j, 1);
        break;
      }
    }
  }
  return out;
}

/** A "Contents" heading whose entries were removed leaves an empty section: drop it. */
function dropEmptyContentsHeading(blocks: any[], ctx: Ctx): any[] {
  return blocks.filter((b, i) => {
    if (b.t !== "Header" || !/^(table of )?contents$/i.test(stringify(b.c[2]).trim())) return true;
    const next = blocks[i + 1];
    const empty = !next || next.t === "Header";
    if (empty) ctx.report.removed.tocEntries++;
    return !empty;
  });
}

/**
 * Pandoc escapes literal square brackets. Where the result cannot be read as link syntax,
 * restore them so the draft reads as typed. Export escapes them again.
 */
export function unescapeText(md: string): string {
  // Angle brackets stay escaped: legal citations (AGLC) wrap URLs in literal <…>.
  // Grid tables keep their escapes: removing a character would break their column alignment.
  return outsideGrids(md, (t) => t.replace(/\\\[([^\]\n]*?)\\\](?![(\[:])/g, "[$1]"));
}

// ---------------------------------------------------------------- complex tables

const MOVED_MARK = "\uE070";
const NOTE_TOKEN = ["\uE060", "\uE061"];
const GRID_OPEN = "\uE050";
const GRID_CLOSE = "\uE051";
const GRID_WRITER = "markdown+grid_tables+pipe_tables-simple_tables-multiline_tables-smart-header_attributes-link_attributes-fenced_divs-bracketed_spans-native_divs-native_spans-raw_attribute-escaped_line_breaks";

function isComplexTable(t: any): boolean {
  const rows: any[] = [...t.c[3][1], ...t.c[4].flatMap((b: any) => [...b[2], ...b[3]]), ...t.c[5][1]];
  return rows.some((r) => r[1].some((cell: any) => cell[2] !== 1 || cell[3] !== 1 || cell[4].length > 1 || (cell[4][0] && !["Plain", "Para"].includes(cell[4][0].t))));
}

/** Replace each complex table with a placeholder and render it as a grid table. */
async function extractComplexTables(blocks: any[], apiVersion: number[], out: string[], labels: string[], moved: any[]): Promise<any[]> {
  const res: any[] = [];
  for (const b of blocks) {
    if (b.t === "Table" && isComplexTable(b)) {
      tokeniseNotes(b, labels, moved);
      // Default column widths: pandoc sizes columns from content, so a round trip is stable.
      b.c[2] = b.c[2].map((cs: any) => [cs[0], { t: "ColWidthDefault" }]);
      const md = await runPandoc(["-f", "json", "-t", GRID_WRITER, "--columns=110"], JSON.stringify({ "pandoc-api-version": apiVersion, meta: {}, blocks: [b] }));
      out.push(md.trim());
      res.push({ t: "Para", c: [str(`${GRID_OPEN}${out.length - 1}${GRID_CLOSE}`)] });
    } else if (b.t === "BlockQuote") {
      res.push({ t: "BlockQuote", c: await extractComplexTables(b.c, apiVersion, out, labels, moved) });
    } else {
      res.push(b);
    }
  }
  return res;
}

/**
 * Notes inside a grid table become a token exactly as long as their final [^LABEL], so the
 * table's fixed-width cells stay aligned. The Note itself moves to a trailing marker paragraph.
 */
function tokeniseNotes(node: any, labels: string[], moved: any[]) {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== "object") return x;
    if (x.t === "Note") {
      const m = new RegExp(`${NOTE_OPEN}(\\d+)${NOTE_CLOSE}`).exec(JSON.stringify(x));
      const idx = m ? Number(m[1]) : -1;
      if (idx < 0 || !labels[idx]) return x;
      moved.push(x);
      const len = labels[idx].length + 3; // [^ + label + ]
      return str(NOTE_TOKEN[0] + String(idx) + NOTE_TOKEN[1].repeat(Math.max(1, len - 1 - String(idx).length)));
    }
    if (x.c !== undefined) x.c = walk(x.c);
    return x;
  };
  walk(node);
}

/** Put each grid table back in place, turning note tokens into their labels. */
function spliceGrids(md: string, grids: string[], labels: string[]): string {
  let out = md;
  grids.forEach((g, i) => {
    const table = padCommentSentinels(g.replace(new RegExp(`${NOTE_TOKEN[0]}(\\d+)${NOTE_TOKEN[1]}+`, "g"), (_, n) => `[^${labels[Number(n)]}]`));
    out = out.replace(`${GRID_OPEN}${i}${GRID_CLOSE}`, () => table);
  });
  return out;
}

/** Comment sentinels in a grid cell are removed later: pad the cell now so widths stay right. */
function padCommentSentinels(grid: string): string {
  const re = new RegExp(`${C_START[0]}[^${C_START[1]}]*${C_START[1]}|${C_END[0]}[^${C_END[1]}]*${C_END[1]}`, "g");
  return grid
    .split("\n")
    .map((line) => {
      if (!line.startsWith("|") || !re.test(line)) return line;
      re.lastIndex = 0;
      // Walk cell by cell: each removed sentinel adds the same number of spaces before the cell's closing bar.
      const cells = line.split("|");
      return cells
        .map((cell, k) => {
          if (k === 0 || k === cells.length - 1) return cell;
          const removed = [...cell.matchAll(re)].reduce((n, m) => n + m[0].length, 0);
          return removed ? cell + " ".repeat(removed) : cell;
        })
        .join("|");
    })
    .join("\n");
}

// ---------------------------------------------------------------- tables report

function countTables(md: string, report: ImportReport) {
  report.tables.html = (md.match(/<table\b/g) ?? []).length;
  report.tables.pipe = (md.match(/^\|(\s*:?-{3,}:?\s*\|)+\s*$/gm) ?? []).length;
}

// ---------------------------------------------------------------- main

export interface ImportOptions {
  docxPath: string;
  outDir: string; // folder that receives <stem>.md and images/
  stem?: string;
  workDir: string; // scratch folder for pandoc's media extraction
  sourceName?: string; // the file name to record, when docxPath is a temporary copy
}

export async function importDocx(o: ImportOptions): Promise<ImportResult> {
  const stem = o.stem ?? slugify(path.basename(o.docxPath));
  const bytes = fs.readFileSync(o.docxPath);
  const zip = await JSZip.loadAsync(bytes);
  const order = await noteOrder(zip);

  fs.mkdirSync(o.workDir, { recursive: true });
  const mediaRoot = path.join(o.workDir, "media");
  const json = await runPandoc(["-f", "docx+styles", "-t", "json", "--track-changes=all", `--extract-media=${mediaRoot}`, o.docxPath]);
  const doc = JSON.parse(json);

  const report: ImportReport = {
    markdownPath: path.join(o.outDir, `${stem}.md`),
    headings: 0, paragraphs: 0, tables: { pipe: 0, grid: 0, html: 0 }, images: [], footnotes: 0, endnotes: 0, comments: 0,
    removed: { tocEntries: 0, trackedDeletions: 0, emptyParagraphs: 0, bookmarks: 0 },
    noteKindSource: "default", warnings: [],
  };
  const ctx: Ctx = {
    report, notes: [], comments: new Map(), images: new Map(), imageHashes: new Map(),
    mediaRoot: o.workDir, imagesDir: path.join(o.outDir, "images"), stem, figCount: 0, meta: {},
  };
  doc.blocks = dropEmptyContentsHeading(cleanBlocks(doc.blocks, ctx), ctx);

  // Footnote or endnote for each note, in order.
  if (order.length === ctx.notes.length) {
    order.forEach((k, i) => (ctx.notes[i].kind = k));
    report.noteKindSource = "document-order";
  } else {
    report.warnings.push(`notes: ${ctx.notes.length} in the text but ${order.length} references in document.xml; all treated as ${order.every((k) => k === "EN") && order.length ? "endnotes" : "footnotes"}`);
    const fallback = order.length && order.every((k) => k === "EN") ? "EN" : "FN";
    ctx.notes.forEach((n) => (n.kind = fallback));
  }

  // Labels: FN01-xxxx, EN01-xxxx, numbered separately in reading order.
  const live = ctx.notes.filter((n) => !n.dropped);
  const totals = { FN: live.filter((n) => n.kind !== "EN").length, EN: live.filter((n) => n.kind === "EN").length };
  const counters = { FN: 0, EN: 0 };
  const seen = new Set<string>();
  const labels = ctx.notes.map((n) => {
    if (n.dropped) return "";
    const k = n.kind ?? "FN";
    counters[k]++;
    let h = shortHash(`${k}${counters[k]}:${n.text}`);
    while (seen.has(h)) h = shortHash(h + "x");
    seen.add(h);
    return `${k}${String(counters[k]).padStart(Math.max(2, String(totals[k]).length), "0")}-${h}`;
  });
  report.footnotes = counters.FN;
  report.endnotes = counters.EN;

  // Complex tables (merged cells, several blocks in a cell) become grid tables, written
  // separately; everything else is GitHub-flavoured markdown. Notes keep one FN/EN sequence.
  const meta = doc.meta ?? {};
  doc.meta = {};
  const grids: string[] = [];
  const moved: any[] = [];
  doc.blocks = await extractComplexTables(doc.blocks, doc["pandoc-api-version"], grids, labels, moved);
  report.tables.grid = grids.length;
  // Notes lifted out of grid tables ride in a marker paragraph so the writer emits their definitions.
  if (moved.length) doc.blocks.push({ t: "Para", c: [str(MOVED_MARK), ...moved] });
  let md = await runPandoc(["-f", "json", "-t", "gfm", "--wrap=none"], JSON.stringify(doc));
  md = md.replace(new RegExp(`^${MOVED_MARK}.*\\n?`, "m"), "");
  md = spliceGrids(md, grids, labels);
  md = unescapeText(relabelNotes(md, labels));
  countTables(md, report);

  // Frontmatter from the Word document properties.
  const fm: Record<string, unknown> = {};
  for (const k of ["title", "subtitle", "author", "date", "abstract"]) {
    if (meta[k]) {
      const v = meta[k].t === "MetaList" ? meta[k].c.map((x: any) => stringify(x.c).trim()) : stringify(meta[k].c).trim();
      if (v && (!Array.isArray(v) || v.length)) fm[k] = v;
    } else if (ctx.meta[k]) {
      fm[k] = k === "author" ? [ctx.meta[k]] : ctx.meta[k];
    }
  }
  fm.source_docx = o.sourceName ?? path.basename(o.docxPath);
  fm.imported = new Date().toISOString().slice(0, 10);
  md = `---\n${YAML.stringify(fm).trim()}\n---\n\n${md.trimStart()}`;

  const { text, comments } = liftComments(md, ctx);
  report.comments = comments.length;
  return { markdown: text, comments, report };
}

/** Replace pandoc's [^n] numbering with FN/EN labels, footnotes then endnotes at the end. */
export function relabelNotes(md: string, labels: string[]): string {
  const defStart = /^\[\^(\d+)\]:[ \t]*/gm;
  const defs: Array<{ n: string; start: number }> = [];
  for (const m of md.matchAll(defStart)) defs.push({ n: m[1], start: m.index! });
  if (!defs.length) return md;
  const bodyEnd = defs[0].start;
  const numToLabel = new Map<string, string>();
  const chunks: Array<{ label: string; text: string }> = [];
  defs.forEach((d, i) => {
    const end = i + 1 < defs.length ? defs[i + 1].start : md.length;
    let chunk = md.slice(d.start, end).replace(/\s+$/, "");
    const m = new RegExp(`^\\[\\^${d.n}\\]:[ \\t]*${NOTE_OPEN}(\\d+)${NOTE_CLOSE}[ \\t]*`).exec(chunk);
    const idx = m ? Number(m[1]) : i;
    const label = labels[idx] ?? `FN${d.n}`;
    numToLabel.set(d.n, label);
    chunk = chunk.replace(m ? m[0] : new RegExp(`^\\[\\^${d.n}\\]:[ \\t]*`), "");
    chunks.push({ label, text: chunk });
  });
  let body = md.slice(0, bodyEnd).replace(/\[\^(\d+)\]/g, (all, n) => (numToLabel.has(n) ? `[^${numToLabel.get(n)}]` : all));
  body = body.replace(new RegExp(`${NOTE_OPEN}\\d+${NOTE_CLOSE}`, "g"), "");
  const num = (l: string) => Number(/^(?:FN|EN)(\d+)/.exec(l)?.[1] ?? 0);
  const fn = chunks.filter((c) => c.label.startsWith("FN")).sort((a, b) => num(a.label) - num(b.label));
  const en = chunks.filter((c) => c.label.startsWith("EN")).sort((a, b) => num(a.label) - num(b.label));
  const render = (list: typeof chunks) => list.map((c) => `[^${c.label}]: ${c.text.replace(/\[\^(\d+)\]/g, (all, n) => (numToLabel.has(n) ? `[^${numToLabel.get(n)}]` : all))}`).join("\n\n");
  let tail = "";
  if (fn.length) tail += `<!-- Footnotes -->\n\n${render(fn)}\n`;
  if (en.length) tail += `${fn.length ? "\n" : ""}<!-- Endnotes -->\n\n${render(en)}\n`;
  return `${body.replace(/\s+$/, "")}\n\n${tail}`;
}

/** Remove comment sentinels and return each comment's offsets in the clean text. */
function liftComments(md: string, ctx: Ctx): { text: string; comments: ImportedComment[] } {
  const re = new RegExp(`${C_START[0]}([^${C_START[1]}]*)${C_START[1]}|${C_END[0]}([^${C_END[1]}]*)${C_END[1]}`, "g");
  let out = "";
  let last = 0;
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const m of md.matchAll(re)) {
    out += md.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[1] !== undefined) starts.set(m[1], out.length);
    else ends.set(m[2], out.length);
  }
  out += md.slice(last);
  const comments: ImportedComment[] = [];
  for (const [id, c] of ctx.comments) {
    let s = starts.get(id) ?? 0;
    let e = ends.get(id) ?? s;
    if (e < s) [s, e] = [e, s];
    while (s < e && /\s/.test(out[s])) s++;
    while (e > s && /\s/.test(out[e - 1])) e--;
    if (e === s) {
      // A point comment: anchor the word that follows.
      const m = /\S+/.exec(out.slice(s));
      if (m) {
        s += m.index;
        e = s + m[0].length;
      }
    }
    comments.push({ author: c.author, date: c.date, text: c.text, start: s, end: e, exact: out.slice(s, e) });
  }
  return { text: out, comments };
}
