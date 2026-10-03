// Import and export as Draftroom operations: file naming, sidecar comments, templates.
// Used by the server routes and the command line (scripts/docx.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { importDocx, slugify, type ImportReport } from "./importDocx.ts";
import { exportDocx, type ExportComment, type ExportReport, type NotesMode } from "./exportDocx.ts";
import { addComments, loadComments } from "../store.ts";
import { locateBlock } from "../../shared/doc.ts";
import { REPO } from "../profile.ts";
import type { Comment } from "../../shared/types.ts";

export const TEMPLATES_DIR = path.join(REPO, "templates");

export function listTemplates(): Array<{ id: string; label: string; path: string }> {
  const idx = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, "templates.json"), "utf8")) as Record<string, string>;
  return Object.entries(idx).map(([id, label]) => ({ id, label, path: path.join(TEMPLATES_DIR, `${id}.docx`) }));
}

/** a.md, a-2.md, a-3.md … */
export function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 2; ; i++) if (!fs.existsSync(`${base}-${i}${ext}`)) return `${base}-${i}${ext}`;
}

export interface ImportOutcome {
  path: string;
  report: ImportReport;
}

/** Import a .docx into outDir: <stem>.md, images/, and Word comments in the sidecar. */
export async function importToFolder(docxPath: string, outDir: string, opts: { name?: string; home?: string } = {}): Promise<ImportOutcome> {
  const sourceName = opts.name ?? path.basename(docxPath);
  fs.mkdirSync(outDir, { recursive: true });
  let stem = slugify(opts.name ?? path.basename(docxPath));
  const mdPath = uniquePath(path.join(outDir, `${stem}.md`));
  stem = path.basename(mdPath, ".md");
  const work = path.join(opts.home ?? path.join(os.homedir(), ".draftroom"), "tmp", `import-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
  try {
    const r = await importDocx({ docxPath, outDir, stem, workDir: work, sourceName });
    fs.writeFileSync(mdPath, r.markdown);
    r.report.markdownPath = mdPath;
    if (r.comments.length) {
      const runId = `word-import-${new Date().toISOString().slice(0, 10)}`;
      const comments: Comment[] = r.comments.map((c, i) => {
        const where = locateBlock(r.markdown, c.start);
        const when = c.date ? new Date(c.date) : null;
        const day = when && !isNaN(when.getTime()) ? when.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
        return {
          id: `${runId}-${String(i + 1).padStart(2, "0")}`, perspective: "word", engine: "word", run_id: runId,
          level: "sentence", severity: "consider", kind: "observation",
          anchor: {
            exact: c.exact, prefix: r.markdown.slice(Math.max(0, c.start - 30), c.start), suffix: r.markdown.slice(c.end, c.end + 30),
            start: c.start, end: c.end, section: where.section, paragraph: where.paragraph,
          },
          scope: "document", title: c.author || "Word comment", rationale: `Word comment${day ? `, ${day}` : ""}${c.author ? ` by ${c.author}` : ""}.`,
          hint: c.text, links: [], proposed_source: null, example: null, status: "open", dismiss_reason: null, stale: false,
          flags: ["word"], created: c.date || new Date().toISOString(),
        };
      });
      addComments(mdPath, r.markdown, comments, { perspective: "word", summary: `${comments.length} comment${comments.length === 1 ? "" : "s"} imported from ${sourceName}.`, run_id: runId, engine: "word", dropped: 0, scope: "document", from: 0, to: r.markdown.length });
    }
    return { path: mdPath, report: r.report };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export type CommentChoice = "none" | "word" | "all";

export interface ExportRequest {
  draftPath: string;
  text: string;
  outPath?: string;
  overwrite?: boolean;
  template: string; // template id or absolute .docx path (already policy-checked)
  scope: "body" | "all";
  titleBlock: boolean;
  notes: NotesMode;
  comments: CommentChoice;
  includeJev?: boolean; // Jev signals are left out of "all open comments" unless asked for
  perspectiveNames?: Record<string, string>;
}

export function defaultExportPath(draftPath: string): string {
  return draftPath.replace(/\.md$/i, ".docx");
}

export function resolveTemplate(t: string): string {
  const builtIn = listTemplates().find((x) => x.id === t);
  if (builtIn) return builtIn.path;
  if (path.isAbsolute(t) && /\.docx$/i.test(t) && fs.existsSync(t)) return t;
  throw new Error(`unknown template ${t}`);
}

export class ExistsError extends Error {}

export async function exportFromDraft(req: ExportRequest): Promise<ExportReport> {
  const out = req.outPath ?? defaultExportPath(req.draftPath);
  if (fs.existsSync(out) && !req.overwrite) throw new ExistsError(`${out} exists`);
  const sc = loadComments(req.draftPath, req.text);
  const chosen = sc.comments.filter((c) => c.anchor && c.status === "open" && !c.stale && (req.comments === "all" || (req.comments === "word" && c.perspective === "word")) && (c.engine !== "jev" || req.includeJev));
  const comments: ExportComment[] = chosen.map((c) => ({
    author: c.perspective === "word" ? c.title : c.engine === "jev" ? "Draftroom · Signals [Jev]" : `Draftroom · ${req.perspectiveNames?.[c.perspective] ?? c.perspective}`,
    date: c.perspective === "word" ? c.created : new Date().toISOString(),
    text: c.perspective === "word" ? c.hint : `${c.title}. ${c.hint}`,
    start: c.anchor!.start,
    end: c.anchor!.end,
  }));
  return exportDocx({
    text: req.text, draftDir: path.dirname(req.draftPath), outPath: out, template: resolveTemplate(req.template),
    scope: req.scope, titleBlock: req.titleBlock, notes: req.notes, comments,
  });
}
