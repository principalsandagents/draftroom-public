// Comment sidecars: <draft dir>/.draftroom/<stem>.comments.json
// Comments never go into the draft file itself.

import fs from "node:fs";
import path from "node:path";
import { reanchor } from "./anchor.ts";
import { hashText, locateBlock } from "../shared/doc.ts";
import type { Comment, Sidecar } from "../shared/types.ts";

export function sidecarDir(draftPath: string): string {
  return path.join(path.dirname(draftPath), ".draftroom");
}

export function sidecarPath(draftPath: string): string {
  const stem = path.basename(draftPath).replace(/\.md$/i, "");
  return path.join(sidecarDir(draftPath), `${stem}.comments.json`);
}

function empty(): Sidecar {
  return { version: 1, file_hash: "", comments: [], summaries: {}, dropped: {} };
}

export function readSidecar(draftPath: string): Sidecar {
  const p = sidecarPath(draftPath);
  if (!fs.existsSync(p)) return empty();
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8")) as Sidecar;
    return { ...empty(), ...s };
  } catch {
    // A corrupt sidecar is kept aside, never silently overwritten.
    fs.renameSync(p, `${p}.corrupt-${Date.now()}`);
    return empty();
  }
}

export function writeSidecar(draftPath: string, sc: Sidecar): void {
  const dir = sidecarDir(draftPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = sidecarPath(draftPath);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sc, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/**
 * Note labels change number when notes are renumbered but keep their suffix (FN03-ab12 -> FN02-ab12).
 * Bring a stored anchor's labels up to date with the labels now in the text, by suffix.
 */
function relabelAnchor(a: { exact: string; prefix: string; suffix: string }, text: string) {
  const current = new Map<string, string>();
  for (const m of text.matchAll(/\[\^((?:FN|EN)\d+-([a-z0-9]+))\]/g)) current.set(m[2], m[1]);
  const fix = (s: string) => s.replace(/\[\^(?:FN|EN)\d+-([a-z0-9]+)\]/g, (all, suf) => (current.has(suf) ? `[^${current.get(suf)}]` : all));
  return { ...a, exact: fix(a.exact), prefix: fix(a.prefix), suffix: fix(a.suffix) };
}

/** Re-anchor every comment against the current text. Updates offsets and stale flags in place. */
export function reanchorAll(sc: Sidecar, text: string): Sidecar {
  const h = hashText(text);
  if (sc.file_hash === h) return sc;
  for (const c of sc.comments) {
    if (!c.anchor) continue;
    if (/\[\^(?:FN|EN)\d+-/.test(c.anchor.exact + c.anchor.prefix + c.anchor.suffix)) c.anchor = { ...c.anchor, ...relabelAnchor(c.anchor, text) };
    const r = reanchor(text, c.anchor);
    if (!r) {
      c.stale = true;
      continue;
    }
    const where = locateBlock(text, r.start);
    c.anchor = { ...c.anchor, start: r.start, end: r.end, section: where.section, paragraph: where.paragraph };
    c.stale = c.stale || r.stale;
  }
  sc.file_hash = h;
  return sc;
}

export function loadComments(draftPath: string, text: string): Sidecar {
  const sc = reanchorAll(readSidecar(draftPath), text);
  return sc;
}

export interface RunMeta {
  perspective: string;
  summary: string;
  run_id: string;
  engine: Comment["engine"];
  dropped: number;
  scope: Comment["scope"];
  from: number; // range the run covered, in current-text offsets
  to: number;
}

// ---------------------------------------------------------------- closed history

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2);
}

function similar(a: string, b: string): number {
  const A = words(a);
  const B = new Set(words(b));
  if (!A.length || !B.size) return 0;
  return (2 * A.filter((w) => B.has(w)).length) / (A.length + B.size);
}

/**
 * Is this new comment a repeat of one the writer has already resolved or dismissed? Same perspective,
 * same place (both whole-draft, the same passage, or overlapping text), and a similar title or hint.
 */
export function repeatsClosed(n: Comment, closed: Comment): boolean {
  if (n.perspective !== closed.perspective || closed.status === "open") return false;
  const a = n.anchor;
  const b = closed.anchor;
  let samePlace: boolean;
  if (!a || !b) samePlace = !a && !b;
  else samePlace = a.exact.trim() === b.exact.trim() || (!closed.stale && a.start < b.end && b.start < a.end);
  if (!samePlace) return false;
  return similar(n.title, closed.title) >= 0.5 || similar(n.hint, closed.hint) >= 0.6;
}

/** Drop new comments that repeat a closed one. Returns the kept comments and how many were held back. */
export function withoutClosedRepeats(sc: Sidecar, fresh: Comment[]): { kept: Comment[]; held: number } {
  const closed = sc.comments.filter((c) => c.status !== "open");
  const kept = fresh.filter((n) => !closed.some((c) => repeatsClosed(n, c)));
  return { kept, held: fresh.length - kept.length };
}

/**
 * Replace a machine check's cards (Jev, quote check, reference check): open old cards go, closed
 * ones stay as history, and fresh cards that repeat a closed one are held back.
 */
export function replaceCards(sc: Sidecar, isOld: (c: Comment) => boolean, fresh: Comment[]): number {
  const { kept, held } = withoutClosedRepeats(sc, fresh);
  sc.comments = [...sc.comments.filter((c) => !(isOld(c) && c.status === "open")), ...kept];
  return held;
}

/**
 * Store a run's comments. A perspective's open comments are replaced when they sit in the range
 * just re-read, when their text is gone (stale), or, for whole-draft points, when the run covered a
 * section or the whole draft. Resolved and dismissed comments stay as history, and a new comment
 * that repeats one of them is held back. Returns how many were held back.
 */
export function addComments(draftPath: string, text: string, comments: Comment[], meta: RunMeta): { sc: Sidecar; held: number } {
  const sc = loadComments(draftPath, text);
  sc.comments = sc.comments.filter((c) => {
    if (c.perspective !== meta.perspective || c.status !== "open") return true;
    if (!c.anchor) return meta.scope === "paragraph" || meta.scope === "selection";
    if (c.stale) return false;
    return !(c.anchor.start >= meta.from && c.anchor.end <= meta.to);
  });
  const { kept, held } = withoutClosedRepeats(sc, comments);
  sc.comments.push(...kept);
  sc.summaries[meta.perspective] = { summary: meta.summary, run_id: meta.run_id, engine: meta.engine, at: new Date().toISOString() };
  sc.dropped[meta.run_id] = meta.dropped;
  writeSidecar(draftPath, sc);
  return { sc, held };
}

export function updateComment(draftPath: string, text: string, id: string, patch: Partial<Pick<Comment, "status" | "dismiss_reason" | "example" | "stale">>): Sidecar {
  const sc = loadComments(draftPath, text);
  const c = sc.comments.find((x) => x.id === id);
  if (!c) throw new Error(`no comment ${id}`);
  if (patch.status && patch.status !== c.status) (c as Comment).closed_at = patch.status === "open" ? null : new Date().toISOString();
  Object.assign(c, patch);
  writeSidecar(draftPath, sc);
  return sc;
}

/** Resolved and dismissed comments from earlier runs, passed to the next run so they are not raised again. */
export function closedFor(sc: Sidecar, perspective: string): string[] {
  return sc.comments
    .filter((c) => c.perspective === perspective && c.status !== "open")
    .slice(-40)
    .map((c) => `- "${c.title}"${c.anchor ? ` at "${c.anchor.exact.slice(0, 60)}"` : " (whole draft)"} (${c.status}${c.dismiss_reason ? `: ${c.dismiss_reason}` : ""})`);
}
