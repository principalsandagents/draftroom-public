// Markdown to Word (.docx).
//
// Pandoc writes the document with the chosen template's styles (and its page set-up, header and
// footer). Draftroom adds what pandoc cannot express:
// - endnotes: notes labelled EN… (or all notes, by option) move from footnotes.xml to a real
//   endnotes part with decimal numbering and Endnote Text / Endnote Reference styles
// - Word comments from the Draftroom sidecar, anchored to their text
// - complex (HTML) tables parsed into Word tables (Lua filter)

import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import YAML from "yaml";
import { runPandoc, PANDOC, gridRanges, outsideGrids } from "./pandoc.ts";
import { ensureEndnoteStyles } from "./styles.ts";
import { bodyStart } from "../../shared/doc.ts";
import { spawn } from "node:child_process";

const EN_MARK = "\uE030";
const LUA = path.join(path.dirname(new URL(import.meta.url).pathname), "lua", "html-tables.lua");

export type NotesMode = "as-labelled" | "footnotes" | "endnotes";

export interface ExportComment {
  author: string;
  date?: string;
  text: string;
  start: number; // offsets into the full markdown text
  end: number;
}

export interface ExportOptions {
  text: string; // the full markdown file
  draftDir: string; // resolves relative image paths
  outPath: string;
  template: string; // reference .docx
  scope: "body" | "all"; // body: after <!-- body --> (Substack posts) without the Prep block
  titleBlock: boolean; // title, subtitle, author and date from frontmatter
  notes: NotesMode;
  comments: ExportComment[];
}

export interface ExportReport {
  outPath: string;
  footnotes: number;
  endnotes: number;
  comments: number;
  commentsCollapsed: number; // anchored at a point because the span crossed markdown syntax
  tables: number;
  images: number;
  warnings: string[];
}

// Pandoc markdown with the extensions that misread ordinary prose turned off:
// $3.50 is not maths, @name is not a citation, ~20 is not a subscript, "| " is not a line block.
export const READER = "markdown-smart-tex_math_dollars-raw_tex-citations-subscript-superscript-line_blocks-markdown_in_html_blocks-example_lists";

function frontmatter(text: string): { fm: Record<string, any>; end: number } {
  if (!text.startsWith("---\n")) return { fm: {}, end: 0 };
  const close = text.indexOf("\n---", 4);
  if (close < 0) return { fm: {}, end: 0 };
  let fm: Record<string, any> = {};
  try {
    fm = YAML.parse(text.slice(4, close)) ?? {};
  } catch {
    /* unreadable frontmatter: ignore */
  }
  const nl = text.indexOf("\n", close + 4);
  return { fm, end: nl < 0 ? text.length : nl + 1 };
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]<>#|$@~^])/g, "\\$1").replace(/\s+/g, " ").trim();
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

function inRanges(pos: number, ranges: Array<[number, number]>): [number, number] | null {
  return ranges.find(([a, b]) => pos >= a && pos < b) ?? null;
}

/** Markup inside a comment span must open and close inside it, or the span would split it. */
export function balanced(span: string): boolean {
  const t = span.replace(/\\./g, "");
  for (const ch of ["*", "_", "`", "~"]) if ((t.split(ch).length - 1) % 2) return false;
  let sq = 0;
  let rd = 0;
  for (const c of t) {
    if (c === "[") sq++;
    if (c === "]" && --sq < 0) return false;
    if (c === "(") rd++;
    if (c === ")" && --rd < 0) return false;
  }
  return sq === 0 && rd === 0 && !/[<>|]/.test(t);
}

/** Comment spans: [text]{.comment-start id author date} … []{.comment-end id}. */
export function insertComments(body: string, offset: number, comments: ExportComment[]): { text: string; collapsed: number; placed: number } {
  type Ins = { at: number; s: string; order: number };
  const ins: Ins[] = [];
  let collapsed = 0;
  let placed = 0;
  const grids = gridRanges(body);
  comments.forEach((c, i) => {
    let s = c.start - offset;
    let e = c.end - offset;
    if (e < 0 || s > body.length) return;
    s = Math.max(0, s);
    e = Math.min(body.length, e);
    const g = inRanges(s, grids) ?? inRanges(Math.max(s, e - 1), grids);
    if (g) {
      // Inside a grid table: a point comment on its own line just before the table.
      const id = String(i + 1);
      const meta = `id="${id}" author="${escapeAttr(c.author || "Draftroom")}"${c.date ? ` date="${escapeAttr(c.date)}"` : ""}`;
      ins.push({ at: g[0], s: `[${escapeMd(c.text) || "(comment)"}]{.comment-start ${meta}}[]{.comment-end id="${id}"}\n\n`, order: 0 });
      collapsed++;
      placed++;
      return;
    }
    const span = body.slice(s, e);
    // A span that crosses a paragraph or markdown syntax could break the markup: anchor it at its start.
    const unsafe = span.includes("\n") || !balanced(span);
    if (unsafe) {
      e = s;
      collapsed++;
    }
    const id = String(i + 1);
    const meta = `id="${id}" author="${escapeAttr(c.author || "Draftroom")}"${c.date ? ` date="${escapeAttr(c.date)}"` : ""}`;
    ins.push({ at: s, s: `[${escapeMd(c.text) || "(comment)"}]{.comment-start ${meta}}`, order: 0 });
    ins.push({ at: e, s: `[]{.comment-end id="${id}"}`, order: 1 });
    placed++;
  });
  ins.sort((a, b) => b.at - a.at || b.order - a.order);
  let out = body;
  for (const x of ins) out = out.slice(0, x.at) + x.s + out.slice(x.at);
  return { text: out, collapsed, placed };
}

/**
 * Square brackets typed as text ("[Add a footnote]") must not read as link syntax, least of all
 * next to a comment span. Escape any [..] that is not a link, image, footnote or span.
 */
export function escapeLiteralBrackets(md: string): string {
  // Grid tables are left alone: an inserted backslash would break their column alignment.
  return outsideGrids(md, escapeOutside);
}

function escapeOutside(md: string): string {
  return md.replace(/(?<![\\!\]])\[([^\[\]\n]*)\](?!\(|\{|:|\[(?!\]\{))/g, (all, inner: string) => (inner.startsWith("^") ? all : `\\[${inner}\\]`));
}

function markEndnotes(md: string, mode: NotesMode): string {
  if (mode === "footnotes") return md;
  return md.replace(/^\[\^([^\]\s]+)\]:[ \t]*/gm, (all, label) => (mode === "endnotes" || /^EN/i.test(label) ? `${all}${EN_MARK}` : all));
}

export function prepareMarkdown(o: ExportOptions): { md: string; collapsed: number; placed: number } {
  const { fm, end } = frontmatter(o.text);
  const hasBody = o.text.includes("<!-- body -->");
  const from = o.scope === "body" && hasBody ? bodyStart(o.text) : end;
  let body = o.text.slice(from);
  const c = insertComments(body, from, o.comments);
  body = c.text;
  body = escapeLiteralBrackets(body.replace(/<!--[\s\S]*?-->/g, ""));
  body = markEndnotes(body, o.notes);
  let head = "";
  if (o.titleBlock) {
    const meta: Record<string, unknown> = {};
    for (const k of ["title", "subtitle", "date"]) if (fm[k]) meta[k] = String(fm[k]);
    const author = fm.author ?? fm.authors;
    if (author) meta.author = author;
    if (Object.keys(meta).length) head = `---\n${YAML.stringify(meta).trim()}\n---\n\n`;
  }
  return { md: head + body, collapsed: c.collapsed, placed: c.placed };
}

// ---------------------------------------------------------------- endnotes

const ENDNOTES_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml";
const ENDNOTES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes";

/** Move footnotes carrying the endnote mark into a real endnotes part. Returns the number moved. */
export async function moveEndnotes(zip: JSZip): Promise<number> {
  const fnPath = "word/footnotes.xml";
  const fnXml = await zip.file(fnPath)?.async("string");
  if (!fnXml || !fnXml.includes(EN_MARK)) return 0;
  const rootOpen = /<w:footnotes\b[^>]*>/.exec(fnXml)![0];
  const moved: string[] = [];
  const ids: string[] = [];
  const keptFn = fnXml.replace(/<w:footnote\b([^>]*)>([\s\S]*?)<\/w:footnote>/g, (all, attrs: string, inner: string) => {
    if (!inner.includes(EN_MARK)) return all;
    const id = /w:id="(-?\d+)"/.exec(attrs)![1];
    ids.push(id);
    const body = inner
      .replace(new RegExp(EN_MARK, "g"), "")
      .replace(/w:footnoteRef\b/g, "w:endnoteRef")
      .replace(/w:val="FootnoteReference"/g, 'w:val="EndnoteReference"')
      .replace(/w:val="Footnote(Block)?Text"/g, 'w:val="EndnoteText"');
    moved.push(`<w:endnote w:id="${id}">${body}</w:endnote>`);
    return "";
  });
  zip.file(fnPath, keptFn);

  const enOpen = rootOpen.replace("<w:footnotes", "<w:endnotes");
  const separators = `<w:endnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto" /></w:pPr><w:r><w:separator /></w:r></w:p></w:endnote><w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto" /></w:pPr><w:r><w:continuationSeparator /></w:r></w:p></w:endnote>`;
  // Hyperlinks and images in a note point at relationships of the part that holds the note.
  const fnRels = await zip.file("word/_rels/footnotes.xml.rels")?.async("string");
  if (fnRels) zip.file("word/_rels/endnotes.xml.rels", fnRels);
  zip.file("word/endnotes.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${enOpen}${separators}${moved.join("")}</w:endnotes>`);

  // References in the body: the reference element and its run's character style.
  let doc = await zip.file("word/document.xml")!.async("string");
  for (const id of ids) {
    const re = new RegExp(`<w:footnoteReference\\s+w:id="${id}"\\s*/>`);
    const m = re.exec(doc);
    if (!m) continue;
    const runStart = Math.max(doc.lastIndexOf("<w:r>", m.index), doc.lastIndexOf("<w:r ", m.index));
    const head = doc.slice(runStart, m.index).replace(/w:val="FootnoteReference"/g, 'w:val="EndnoteReference"');
    doc = doc.slice(0, runStart) + head + `<w:endnoteReference w:id="${id}" />` + doc.slice(m.index + m[0].length);
  }
  zip.file("word/document.xml", doc);

  // Content type, relationship, settings, styles.
  const ctPath = "[Content_Types].xml";
  let ct = await zip.file(ctPath)!.async("string");
  if (!ct.includes("/word/endnotes.xml")) ct = ct.replace("</Types>", `<Override PartName="/word/endnotes.xml" ContentType="${ENDNOTES_CT}" /></Types>`);
  zip.file(ctPath, ct);
  const relPath = "word/_rels/document.xml.rels";
  let rels = await zip.file(relPath)!.async("string");
  if (!rels.includes(ENDNOTES_REL)) rels = rels.replace("</Relationships>", `<Relationship Id="rIdDraftroomEndnotes" Type="${ENDNOTES_REL}" Target="endnotes.xml" /></Relationships>`);
  zip.file(relPath, rels);
  const setPath = "word/settings.xml";
  let settings = await zip.file(setPath)!.async("string");
  const enPr = `<w:endnotePr><w:numFmt w:val="decimal" /><w:endnote w:id="-1" /><w:endnote w:id="0" /></w:endnotePr>`;
  if (/<w:endnotePr\b/.test(settings)) {
    settings = settings.replace(/<w:endnotePr\b[^>]*>[\s\S]*?<\/w:endnotePr>|<w:endnotePr\s*\/>/, enPr);
  } else if (settings.includes("</w:footnotePr>")) {
    settings = settings.replace("</w:footnotePr>", `</w:footnotePr>${enPr}`);
  } else {
    // CT_Settings order: endnotePr comes before compat and rsids.
    const at = settings.search(/<w:compat\b|<w:rsids\b|<m:mathPr\b|<w:themeFontLang\b/);
    settings = at > 0 ? settings.slice(0, at) + enPr + settings.slice(at) : settings.replace("</w:settings>", `${enPr}</w:settings>`);
  }
  zip.file(setPath, settings);
  const stylesXml = await zip.file("word/styles.xml")!.async("string");
  zip.file("word/styles.xml", ensureEndnoteStyles(stylesXml));
  return ids.length;
}

// ---------------------------------------------------------------- main

function pandocWithStderr(args: string[], input: string): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(PANDOC, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`pandoc not available (${e.message}); install with: brew install pandoc`)));
    p.on("close", (code) => (code === 0 ? resolve({ stderr: err }) : reject(new Error(`pandoc exited ${code}: ${err.slice(0, 400)}`))));
    p.stdin.end(input);
  });
}

export async function exportDocx(o: ExportOptions): Promise<ExportReport> {
  const prep = prepareMarkdown(o);
  const tmp = `${o.outPath}.draftroom-tmp.docx`;
  const { stderr } = await pandocWithStderr(
    ["-f", READER, "-t", "docx", "--reference-doc", o.template, "--resource-path", o.draftDir, "--lua-filter", LUA, "-o", tmp],
    prep.md,
  );
  const zip = await JSZip.loadAsync(fs.readFileSync(tmp));
  const endnotes = await moveEndnotes(zip);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, o.outPath);

  const doc = await zip.file("word/document.xml")!.async("string");
  const fnXml = (await zip.file("word/footnotes.xml")?.async("string")) ?? "";
  const cmXml = (await zip.file("word/comments.xml")?.async("string")) ?? "";
  const warnings = stderr
    .split("\n")
    .filter((l) => /WARNING|Could not/i.test(l))
    .map((l) => l.replace(/^\[WARNING\]\s*/, "").trim())
    .filter(Boolean)
    .map((w) =>
      /Could not convert image (\S+?):.*rsvg-convert/.test(w)
        ? `${/Could not convert image (\S+?):/.exec(w)![1]}: SVG embedded without a PNG fallback. Word 2016 and later show it; for older Word run: brew install librsvg`
        : w,
    );
  return {
    outPath: o.outPath,
    footnotes: (fnXml.match(/<w:footnote w:id="(?!-1"|0")/g) ?? []).length,
    endnotes,
    comments: (cmXml.match(/<w:comment\b/g) ?? []).length,
    commentsCollapsed: prep.collapsed,
    tables: (doc.match(/<w:tbl>/g) ?? []).length,
    images: (doc.match(/<pic:pic\b/g) ?? []).length,
    warnings,
  };
}

export { runPandoc };
