import type { Comment, PerspectiveMeta, Scope } from "../../../shared/types.ts";
import { LEVELS, SEVERITIES } from "../../../shared/types.ts";

export type Detail = "summary" | "cards" | "full";
export type StatusFilter = "open" | "resolved" | "dismissed" | "stale" | "all";

export interface Filters {
  severities: Set<string>;
  levels: Set<string>;
  status: StatusFilter;
  hocFirst: boolean; // hide sentence and mechanics until argument and structure are clear
}

export const BLOCK_LEVELS = new Set(["argument", "structure", "paragraph"]);

export function rank(c: Comment): number {
  return LEVELS.indexOf(c.level) * 10 + SEVERITIES.indexOf(c.severity);
}

export function byDocumentOrder(a: Comment, b: Comment): number {
  if (!a.anchor && !b.anchor) return rank(a) - rank(b);
  if (!a.anchor) return -1;
  if (!b.anchor) return 1;
  return a.anchor.start - b.anchor.start;
}

export function isStale(c: Comment, local: Set<string>): boolean {
  return c.stale || local.has(c.id);
}

export function hocBlocked(comments: Comment[]): boolean {
  return comments.some((c) => c.status === "open" && (c.level === "argument" || c.level === "structure"));
}

export function applyFilters(comments: Comment[], f: Filters, local: Set<string>): Comment[] {
  const blocked = f.hocFirst && hocBlocked(comments);
  return comments.filter((c) => {
    if (f.status === "stale") {
      if (!isStale(c, local) || c.status !== "open") return false;
    } else if (f.status !== "all" && c.status !== f.status) return false;
    if (f.severities.size && !f.severities.has(c.severity)) return false;
    if (f.levels.size && !f.levels.has(c.level)) return false;
    if (blocked && c.perspective !== "word" && (c.level === "sentence" || c.level === "mechanics")) return false;
    return true;
  });
}

/** Narrowest scope a perspective allows that contains an anchor: for Recheck. */
export function recheckScope(p: PerspectiveMeta): Scope {
  for (const s of ["paragraph", "section", "document"] as Scope[]) if (p.scopes.includes(s)) return s;
  return p.default_scope;
}

export const SCOPE_LABEL: Record<string, string> = {
  selection: "Selection", paragraph: "Paragraph", section: "Section", document: "Document", none: "Whole draft",
};

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
