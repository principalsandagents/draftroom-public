// Build the Word export templates from pandoc's default reference document.
// Run: npx tsx scripts/make-templates.ts   (writes templates/*.docx)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";
import { applyTheme, ensureEndnoteStyles, type Theme } from "../server/docx/styles.ts";

const OUT = path.join(import.meta.dirname, "..", "templates");
const base = execFileSync(process.env.DRAFTROOM_PANDOC ?? "pandoc", ["--print-default-data-file", "reference.docx"]);

const THEMES: Record<string, { label: string; theme?: Theme }> = {
  plain: { label: "Plain (pandoc default: Calibri-style body, blue headings)" },
  report: { label: "Report (Arial 11, navy headings, 1.15 spacing)", theme: { bodyFont: "Arial", headingFont: "Arial", bodySize: 22, line: 276, headingColor: "1F3864", titleAlign: "left", noteSize: 18 } },
  essay: { label: "Essay (Georgia 12, dark headings, 1.4 spacing)", theme: { bodyFont: "Georgia", headingFont: "Georgia", bodySize: 24, line: 336, headingColor: "222222", titleAlign: "left", noteSize: 20 } },
};

fs.mkdirSync(OUT, { recursive: true });
const index: Record<string, string> = {};
for (const [id, t] of Object.entries(THEMES)) {
  const zip = await JSZip.loadAsync(base);
  let styles = await zip.file("word/styles.xml")!.async("string");
  styles = ensureEndnoteStyles(styles);
  if (t.theme) styles = applyTheme(styles, t.theme);
  zip.file("word/styles.xml", styles);
  fs.writeFileSync(path.join(OUT, `${id}.docx`), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  index[id] = t.label;
}
fs.writeFileSync(path.join(OUT, "templates.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`wrote ${Object.keys(index).length} templates to ${OUT}`);
