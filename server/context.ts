// Article context: <draft dir>/.draftroom/context.yaml (gitignored in the workspace).
// Pre-filled from a Substack post's frontmatter and `## Prep` block when present.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import Ajv from "ajv";
import { sidecarDir } from "./store.ts";
import type { ArticleContext } from "../shared/types.ts";
import contextSchema from "../shared/schema/context.schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(contextSchema as object);

export function contextPath(draftPath: string): string {
  const stem = path.basename(draftPath).replace(/\.md$/i, "");
  return path.join(sidecarDir(draftPath), `${stem}.context.yaml`);
}

const FORMAT_MAP: Record<string, string> = {
  take: "substack-take",
  "field-notes": "field-notes",
  roundup: "roundup",
  "op-ed": "op-ed",
};

function frontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n")) return {};
  const close = text.indexOf("\n---", 4);
  if (close < 0) return {};
  try {
    return (YAML.parse(text.slice(4, close)) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function prepField(prep: string, label: RegExp): string | undefined {
  const m = new RegExp(`\\*\\*${label.source}:?\\*\\*:?\\s*(.+)`, "i").exec(prep);
  return m ? m[1].trim() : undefined;
}

// Frontmatter `project` → publication and voice, from the profile (configureContext).
let publications: Record<string, { publication: string; voice?: string }> = {};
export function configureContext(p: typeof publications | undefined): void {
  publications = p ?? {};
}

/** Pre-fill from Substack frontmatter and the `## Prep` block. Never overwrites saved fields. */
export function importFromDraft(draftPath: string, text: string): ArticleContext {
  const fm = frontmatter(text);
  const ctx: ArticleContext = {};
  if (typeof fm.title === "string" && fm.title) ctx.title = fm.title;
  if (typeof fm.frame === "string" && fm.frame.trim()) ctx.frame = fm.frame.trim();
  if (typeof fm.format === "string") ctx.format = FORMAT_MAP[fm.format] ?? "other";
  const pub = typeof fm.project === "string" ? publications[fm.project] : undefined;
  if (pub) {
    ctx.publication = pub.publication;
    if (pub.voice) ctx.voice = pub.voice;
  }
  const bodyAt = text.indexOf("<!-- body -->");
  const prepAt = text.indexOf("## Prep");
  if (prepAt >= 0) {
    const prep = text.slice(prepAt, bodyAt > prepAt ? bodyAt : undefined);
    const who = prepField(prep, /Who it is for/);
    const what = prepField(prep, /What they should do afterwards/);
    if (who) ctx.audience = who;
    const frame = prepField(prep, /Frame/);
    if (frame) ctx.frame = frame;
    if (what) ctx.purpose = what;
    const kp = /### Key points to argue\s*\n+\s*1\.\s+\*\*([^*]+)\*\*/.exec(prep);
    if (kp) ctx.key_claim = kp[1].trim();
  }
  const sources = path.join(path.dirname(draftPath), "sources.md");
  if (fs.existsSync(sources)) ctx.sources_file = sources;
  else {
    const reg = fs.readdirSync(path.dirname(draftPath)).find((f) => /source-register\.md$/.test(f));
    if (reg) ctx.sources_file = path.join(path.dirname(draftPath), reg);
  }
  return ctx;
}

export function loadContext(draftPath: string, text: string): { context: ArticleContext; saved: boolean } {
  const p = contextPath(draftPath);
  const imported = importFromDraft(draftPath, text);
  if (!fs.existsSync(p)) return { context: imported, saved: false };
  const saved = (YAML.parse(fs.readFileSync(p, "utf8")) ?? {}) as ArticleContext;
  // Saved fields win; imported fields fill gaps.
  return { context: { ...imported, ...stripEmpty(saved) }, saved: true };
}

function stripEmpty(c: ArticleContext): ArticleContext {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length))) as ArticleContext;
}

export function saveContext(draftPath: string, ctx: ArticleContext): void {
  const clean = stripEmpty(ctx);
  if (!validate(clean)) throw new Error(`context invalid: ${ajv.errorsText(validate.errors)}`);
  fs.mkdirSync(sidecarDir(draftPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(contextPath(draftPath), YAML.stringify(clean), { mode: 0o600 });
}

export function contextForPrompt(ctx: ArticleContext): string {
  const c = stripEmpty(ctx);
  if (!Object.keys(c).length) return "(No article context set. Assume an informed professional audience; say so if that limits your review.)";
  return YAML.stringify(c).trim();
}
