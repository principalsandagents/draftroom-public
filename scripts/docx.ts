// Word import and export from the command line.
//
//   npx tsx scripts/docx.ts import <file.docx> [--out <folder>] [--name <stem>]
//   npx tsx scripts/docx.ts export <draft.md> [--out <file.docx>] [--template report|essay|plain|<path.docx>]
//        [--notes as-labelled|footnotes|endnotes] [--comments none|word|all] [--scope body|all]
//        [--no-title] [--overwrite]
//   npx tsx scripts/docx.ts templates

import fs from "node:fs";
import path from "node:path";
import { importToFolder, exportFromDraft, listTemplates, ExistsError } from "../server/docx/service.ts";

const [cmd, target, ...rest] = process.argv.slice(2);
const flag = (name: string, d?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : d;
};
const has = (name: string) => rest.includes(`--${name}`);

async function main() {
  if (cmd === "templates") {
    for (const t of listTemplates()) console.log(`${t.id.padEnd(8)} ${t.label}`);
    return;
  }
  if (!target) throw new Error("usage: docx.ts import|export <path> [options]  (see the file header)");
  const abs = path.resolve(target);
  if (cmd === "import") {
    const out = path.resolve(flag("out", path.dirname(abs))!);
    const r = await importToFolder(abs, out, { name: flag("name") });
    const rep = r.report;
    console.log(`Imported ${path.basename(abs)} → ${r.path}`);
    console.log(`  ${rep.headings} headings, ${rep.paragraphs} paragraphs`);
    console.log(`  notes: ${rep.footnotes} footnotes, ${rep.endnotes} endnotes (kind from ${rep.noteKindSource})`);
    console.log(`  tables: ${rep.tables.pipe} pipe, ${rep.tables.grid} grid; images: ${rep.images.length}; comments: ${rep.comments} (in the Draftroom sidecar)`);
    console.log(`  removed: ${rep.removed.tocEntries} contents entries, ${rep.removed.trackedDeletions} tracked deletions, ${rep.removed.emptyParagraphs} empty paragraphs`);
    for (const w of rep.warnings) console.log(`  warning: ${w}`);
    return;
  }
  if (cmd === "export") {
    const text = fs.readFileSync(abs, "utf8");
    try {
      const r = await exportFromDraft({
        draftPath: abs, text, outPath: flag("out") ? path.resolve(flag("out")!) : undefined, overwrite: has("overwrite"),
        template: flag("template", "report")!, scope: (flag("scope") as any) ?? (text.includes("<!-- body -->") ? "body" : "all"),
        titleBlock: !has("no-title"), notes: (flag("notes", "as-labelled") as any), comments: (flag("comments", "none") as any),
      });
      console.log(`Exported → ${r.outPath}`);
      console.log(`  ${r.footnotes} footnotes, ${r.endnotes} endnotes, ${r.comments} comments${r.commentsCollapsed ? ` (${r.commentsCollapsed} anchored at a point)` : ""}, ${r.tables} tables, ${r.images} images`);
      for (const w of r.warnings) console.log(`  warning: ${w}`);
    } catch (e) {
      if (e instanceof ExistsError) throw new Error(`${e.message}; pass --overwrite or --out`);
      throw e;
    }
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
