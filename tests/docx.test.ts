// Word import and export, end to end through pandoc and a synthetic Word file that carries
// what real documents do: header, footer with a page number, contents entries, tracked changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { exportDocx, insertComments, balanced, escapeLiteralBrackets, moveEndnotes } from "../server/docx/exportDocx.ts";
import { importDocx, relabelNotes, unescapeText, slugify } from "../server/docx/importDocx.ts";
import { gridRanges } from "../server/docx/pandoc.ts";
import { listTemplates } from "../server/docx/service.ts";

const FX = path.join(import.meta.dirname, "fixtures", "docx");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "draftroom-docx-")));
const srcDir = path.join(tmp, "src");
const source = fs.readFileSync(path.join(FX, "source.md"), "utf8");
let exported = "";
let wordFile = "";
let imported: Awaited<ReturnType<typeof importDocx>>;
let zipXml: Record<string, string> = {};

/** Add what Word documents carry and pandoc does not write. */
async function wordify(file: string, out: string) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}><w:p><w:r><w:t>CONFIDENTIAL HEADER TEXT</w:t></w:r></w:p></w:hdr>`);
  zip.file("word/footer1.xml", `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">FOOTER Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`);
  let rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  rels = rels.replace("</Relationships>", `<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", rels);
  let ct = await zip.file("[Content_Types].xml")!.async("string");
  ct = ct.replace("</Types>", `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.file("[Content_Types].xml", ct);
  let styles = await zip.file("word/styles.xml")!.async("string");
  styles = styles.replace("</w:styles>", `<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style></w:styles>`);
  zip.file("word/styles.xml", styles);
  let doc = await zip.file("word/document.xml")!.async("string");
  const toc = `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>Contents entry one</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>Contents entry two</w:t></w:r></w:p>`;
  const tracked = `<w:p><w:r><w:t xml:space="preserve">Tracked: </w:t></w:r><w:ins w:id="901" w:author="Editor" w:date="2026-09-01T00:00:00Z"><w:r><w:t xml:space="preserve">inserted words </w:t></w:r></w:ins><w:del w:id="902" w:author="Editor" w:date="2026-09-01T00:00:00Z"><w:r><w:delText>deleted words </w:delText></w:r></w:del><w:r><w:t>end.</w:t></w:r></w:p>`;
  doc = doc.replace(/<w:body>/, `<w:body>${toc}`).replace(/<w:sectPr\b([^>]*)>/, `${tracked}<w:sectPr$1><w:headerReference w:type="default" r:id="rIdH1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><w:footerReference w:type="default" r:id="rIdF1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>`);
  zip.file("word/document.xml", doc);
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));
}

beforeAll(async () => {
  fs.mkdirSync(srcDir, { recursive: true });
  fs.copyFileSync(path.join(FX, "chart.png"), path.join(srcDir, "chart.png"));
  exported = path.join(tmp, "exported.docx");
  const anchor = "The contract sets the terms";
  const start = source.indexOf(anchor);
  const r = await exportDocx({
    text: source, draftDir: srcDir, outPath: exported, template: listTemplates().find((t) => t.id === "report")!.path,
    scope: "all", titleBlock: true, notes: "as-labelled",
    comments: [{ author: "Reviewer A", date: "2026-09-01T00:00:00Z", text: "Is this always true?", start, end: start + anchor.length }],
  });
  expect(r.footnotes).toBe(2);
  expect(r.endnotes).toBe(2);
  expect(r.comments).toBe(1);
  expect(r.images).toBe(1);
  expect(r.tables).toBe(2);
  const zip = await JSZip.loadAsync(fs.readFileSync(exported));
  for (const n of ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml", "word/settings.xml", "word/styles.xml", "[Content_Types].xml", "word/_rels/document.xml.rels", "word/comments.xml"]) zipXml[n] = (await zip.file(n)?.async("string")) ?? "";
  zipXml.endnoteRels = (await zip.file("word/_rels/endnotes.xml.rels")?.async("string")) ?? "";
  wordFile = path.join(tmp, "word-like.docx");
  await wordify(exported, wordFile);
  imported = await importDocx({ docxPath: wordFile, outDir: path.join(tmp, "out"), stem: "procurement", workDir: path.join(tmp, "work") });
}, 120_000);

describe("export", () => {
  it("writes real endnotes with decimal numbering and their own relationships", () => {
    expect((zipXml["word/endnotes.xml"].match(/<w:endnote w:id="(?!-1"|0")/g) ?? []).length).toBe(2);
    expect(zipXml["word/document.xml"]).toMatch(/<w:endnoteReference w:id="\d+"/);
    expect(zipXml["word/settings.xml"]).toMatch(/<w:endnotePr><w:numFmt w:val="decimal" \/>/);
    expect(zipXml["[Content_Types].xml"]).toContain("/word/endnotes.xml");
    expect(zipXml["word/_rels/document.xml.rels"]).toContain("relationships/endnotes");
    expect(zipXml["word/styles.xml"]).toContain('w:styleId="EndnoteText"');
    expect(zipXml.endnoteRels).toContain("example.org/endnote");
    expect(zipXml["word/footnotes.xml"]).not.toContain("\uE030");
    expect(zipXml["word/endnotes.xml"]).not.toContain("\uE030");
  });
  it("keeps prose literal: dollars, tildes and @ are text", () => {
    const d = zipXml["word/document.xml"];
    expect(d).toContain("$3.50");
    expect(d).toContain("~20");
    expect(d).toContain("@someone");
    expect(d).not.toContain("<m:oMath");
  });
  it("writes the comment, the title block, the figure caption and literal brackets", () => {
    expect(zipXml["word/comments.xml"]).toContain("Is this always true?");
    expect(zipXml["word/comments.xml"]).toContain('w:author="Reviewer A"');
    expect(zipXml["word/document.xml"]).toContain("Procurement and AI");
    expect(zipXml["word/document.xml"]).toContain("Figure 1. Adoption by sector");
    expect(zipXml["word/document.xml"]).toContain("[Add a source here]");
  });
  it("produces well-formed XML in every part", async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(exported));
    for (const n of Object.keys(zip.files).filter((f) => /\.(xml|rels)$/.test(f))) {
      const x = await zip.file(n)!.async("string");
      expect(x.split("<").length, n).toBe(x.split(">").length);
    }
  });
});

describe("import of a Word-like file", () => {
  const md = () => imported.markdown;
  it("drops header, footer, page number and contents entries", () => {
    expect(md()).not.toContain("CONFIDENTIAL HEADER");
    expect(md()).not.toContain("FOOTER Page");
    expect(md()).not.toContain("Contents entry");
    expect(imported.report.removed.tocEntries).toBe(2);
  });
  it("accepts tracked insertions and drops deletions", () => {
    expect(md()).toContain("Tracked: inserted words end.");
    expect(md()).not.toContain("deleted words");
  });
  it("keeps footnotes and endnotes apart with FN/EN labels and linked definitions", () => {
    expect(imported.report.footnotes).toBe(2);
    expect(imported.report.endnotes).toBe(2);
    expect(imported.report.noteKindSource).toBe("document-order");
    const refs = [...md().matchAll(/\[\^((?:FN|EN)\d{2}-[a-z0-9]{4})\](?!:)/g)].map((m) => m[1]);
    const defs = [...md().matchAll(/^\[\^((?:FN|EN)\d{2}-[a-z0-9]{4})\]:/gm)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(defs));
    expect(defs.filter((d) => d.startsWith("FN"))).toHaveLength(2);
    expect(md()).toMatch(/<!-- Footnotes -->[\s\S]*<!-- Endnotes -->/);
    expect(md()).toMatch(/\[\^EN01-[a-z0-9]{4}\]: An endnote\. See <https:\/\/example\.org\/endnote>\./);
  });
  it("puts the note inside the complex table into the same sequence, with the table intact", () => {
    expect(imported.report.tables.grid).toBe(1);
    expect(imported.report.tables.pipe).toBe(1);
    const [a, b] = gridRanges(md())[0];
    const grid = md().slice(a, b).trimEnd().split("\n");
    expect(new Set(grid.map((l) => l.length)).size).toBe(1); // every grid line the same width
    expect(md().slice(a, b)).toMatch(/\[\^FN02-[a-z0-9]{4}\]/);
  });
  it("saves the image with a unique name and references it in place with its caption", () => {
    expect(imported.report.images).toHaveLength(1);
    const img = imported.report.images[0];
    expect(img.file).toMatch(/^procurement-fig01-[a-z0-9]{6}\.png$/);
    expect(fs.existsSync(path.join(tmp, "out", "images", img.file))).toBe(true);
    expect(md()).toContain(`![Figure 1. Adoption by sector](images/${img.file} "${img.id}")`);
  });
  it("maps the title to frontmatter and headings to markdown", () => {
    expect(md()).toMatch(/^---\ntitle: Procurement and AI\nsubtitle: A test document\nauthor:\n  - A. Writer/);
    expect(md()).toContain("\n# Why procurement matters\n");
    expect(md()).toContain("\n## Evidence\n");
  });
  it("lifts the Word comment out of the text and anchors it", () => {
    expect(imported.comments).toHaveLength(1);
    const c = imported.comments[0];
    expect(c.author).toBe("Reviewer A");
    expect(c.text).toBe("Is this always true?");
    expect(md().slice(c.start, c.end)).toBe("The contract sets the terms");
    expect(md()).not.toMatch(/[\uE000-\uE0FF]/);
  });
  it("keeps literal brackets as typed", () => {
    expect(md()).toContain("[Add a source here] before publishing.");
  });
});

describe("helpers", () => {
  it("relabels pandoc's numbered notes using the sentinels", () => {
    const md = "Text.[^1] More.[^2]\n\n[^1]: \uE0201\uE021Second note.\n\n[^2]: \uE0200\uE021First note.\n";
    const out = relabelNotes(md, ["FN01-aaaa", "EN01-bbbb"]);
    expect(out).toContain("Text.[^EN01-bbbb] More.[^FN01-aaaa]");
    expect(out).toContain("[^FN01-aaaa]: First note.");
    expect(out).toContain("[^EN01-bbbb]: Second note.");
  });
  it("unescapes plain brackets but not links or citations' angle brackets", () => {
    expect(unescapeText("A \\[note\\] and \\<https://x.org\\>")).toBe("A [note] and \\<https://x.org\\>");
  });
  it("escapes literal brackets for export, leaving links, footnotes and spans", () => {
    expect(escapeLiteralBrackets("[Add] [link](u) [^FN01-a] ![i](p) [c]{.x}")).toBe("\\[Add\\] [link](u) [^FN01-a] ![i](p) [c]{.x}");
  });
  it("checks markup balance for comment spans", () => {
    expect(balanced("plain words")).toBe(true);
    expect(balanced("half *bold")).toBe(false);
    expect(balanced("a [link](u) b")).toBe(true);
  });
  it("collapses a comment that would split markup, and puts table comments before the table", () => {
    const body = "Some *bold text* here.";
    const r = insertComments(body, 0, [{ author: "A", text: "x", start: 5, end: 11 }]);
    expect(r.collapsed).toBe(1);
    const grid = "Intro.\n\n+---+\n| a |\n+---+\n";
    const g = insertComments(grid, 0, [{ author: "A", text: "y", start: grid.indexOf("a |"), end: grid.indexOf("a |") + 1 }]);
    expect(g.text).toMatch(/\]\{\.comment-end id="1"\}\n\n\+---\+/);
  });
  it("slugifies file names", () => {
    expect(slugify("26.07.13 ACME Memo to Finance (final v2).docx")).toBe("26-07-13-acme-memo-to-finance-final-v2");
  });
  it("moveEndnotes does nothing when no note is marked", async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(exported));
    expect(await moveEndnotes(zip)).toBe(0);
  });
});
