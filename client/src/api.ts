// Thin fetch wrapper. The browser sends Origin on non-GET requests, which the server requires.

import type { ArticleContext, PerspectiveMeta, RunRequest, Sidecar } from "../../shared/types.ts";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `${r.status}`), { status: r.status });
  return j as T;
}

export interface State {
  file: string | null;
  perspectives: PerspectiveMeta[];
  usage: Record<string, number>;
  active: number;
  max_concurrent: number;
  examples_per_day: number;
  profile: string;
  drafts_root: string;
  workspace?: string;
  voices: Array<{ key: string; label: string }>;
  new_drafts_dir: string;
  profile_warnings: string[];
}

export interface FileData { path: string; content: string; hash: string; words: number }
export interface RunResult { run_id: string; ok: boolean; message: string; added: number; dropped: number; dropped_reasons: string[] }
export interface BrowseData { dir: string; parent: string | null; entries: Array<{ name: string; dir: boolean; path: string; mtime: number }> }

export interface ImportReport {
  markdownPath: string; headings: number; paragraphs: number; tables: { pipe: number; grid: number; html: number };
  images: Array<{ id: string; file: string; alt: string }>; footnotes: number; endnotes: number; comments: number;
  removed: { tocEntries: number; trackedDeletions: number; emptyParagraphs: number; bookmarks: number };
  noteKindSource: string; warnings: string[];
}
export interface ExportReport { outPath: string; footnotes: number; endnotes: number; comments: number; commentsCollapsed: number; tables: number; images: number; warnings: string[] }
export interface ExportOptions { template: string; scope: "body" | "all"; title_block: boolean; notes: "as-labelled" | "footnotes" | "endnotes"; comments: "none" | "word" | "all"; include_jev?: boolean; out_path?: string; overwrite?: boolean }

async function upload<T>(url: string, file: File): Promise<T> {
  const r = await fetch(url, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" }, credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? `${r.status}`), { status: r.status });
  return j as T;
}

export interface JevStatus {
  enabled: boolean;
  consented?: boolean;
  reason: string | null;
  model?: string | null;
  version: number;
  questions_total: number;
  consent_text: string;
  questions?: Array<{ key: string; title: string; enabled: boolean; trial: boolean; outcomes: number; precision: number | null; retire: boolean }>;
  today: { calls: number; tokens: number; cost_usd: number };
}
export interface NoteValidation {
  claim: string;
  at: string;
  sources: Array<{
    label: string;
    exists: { status: string; detail: string };
    details: { status: string; diffs: string[] };
    fulltext: { status: string; detail: string; library_id?: string };
    relevance: { status: string; detail: string };
    support: { status: string; detail: string; passage?: string; passage_verified?: boolean };
  }>;
}
export interface CitePreviewData {
  style: string;
  entries: Array<{ label: string; before: string; after: string; warnings: string[]; filled: Array<{ field: string; value: string; from: string }>; lossy: boolean }>;
  unchanged: number;
  skipped: Array<{ label: string; reason: string }>;
  order_key: string;
}
export interface CiteStatus {
  style: string | null;
  checked_at: string | null;
  formatted: { style: string; order_key: string; at: string } | null;
  positions_stale: boolean;
  notes: Array<{ label: string; body: string; url: string | null; host: string | null; lead_only: boolean; linked: string | null; fetched: string | null; refs: number; quotes: Array<{ quote: string; status: string; detail: string }>; validation: NoteValidation | null }>;
}
export interface JevPass { ok: boolean; reason?: string; paragraphs: number; scored: number; cached: number; flagged: number; skipped_budget: number; model: string | null; error?: string }

export const api = {
  state: () => call<State>("GET", "/api/state"),
  open: (path: string) => call<FileData>("GET", `/api/file?path=${encodeURIComponent(path)}`),
  save: (path: string, content: string, base_hash: string) => call<{ path: string; hash: string; words: number }>("PUT", "/api/file", { path, content, base_hash }),
  acceptDisk: (path: string, hash: string) => call("POST", "/api/file/accept-disk", { path, hash }),
  browse: (dir?: string) => call<BrowseData>("GET", `/api/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  comments: (path: string, text: string) => call<Sidecar>("POST", "/api/comments/load", { path, text }),
  updateComment: (path: string, text: string, id: string, patch: Record<string, unknown>) => call<Sidecar>("POST", "/api/comments/update", { path, text, id, patch }),
  context: (path: string, text: string) => call<{ context: ArticleContext; saved: boolean }>("POST", "/api/context/load", { path, text }),
  saveContext: (path: string, context: ArticleContext) => call("PUT", "/api/context", { path, context }),
  estimate: (b: { perspective: string; scope: string; text: string; from?: number; to?: number }) => call<{ tokens: number }>("POST", "/api/estimate", b),
  run: (req: RunRequest) => call<RunResult>("POST", "/api/run", req),
  cancel: (run_id: string) => call("POST", "/api/run/cancel", { run_id }),
  jevStatus: (path: string) => call<JevStatus>("GET", `/api/jev/status?path=${encodeURIComponent(path)}`),
  jevEnable: (path: string) => call("POST", "/api/jev/enable", { path }),
  jevDisable: (path: string, text: string) => call("POST", "/api/jev/disable", { path, text }),
  jevScore: (path: string, text: string) => call<JevPass>("POST", "/api/jev/score", { path, text }),
  citeStatus: (path: string, text: string) => call<CiteStatus>("POST", "/api/cite/status", { path, text }),
  citeCheck: (path: string, text: string) => call<{ quotes: number; exact: number; close: number; not_found: number; not_checked: number }>("POST", "/api/cite/check-quotes", { path, text }),
  citeFormat: (path: string, text: string, style: string) => call<CitePreviewData>("POST", "/api/cite/format", { path, text, style }),
  citeAccepted: (path: string, text: string, style: string) => call("POST", "/api/cite/accepted", { path, text, style }),
  citeValidate: (path: string, text: string, labels?: string[]) => call<{ notes: number; sources: number; problems: number }>("POST", "/api/cite/validate", { path, text, labels }),
  citeStyle: (path: string, style: string) => call("POST", "/api/cite/style", { path, style }),
  citeLink: async (path: string, label: string, file: File) => {
    const r = await fetch(`/api/cite/link?path=${encodeURIComponent(path)}&label=${encodeURIComponent(label)}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: file, credentials: "same-origin", headers: { "content-type": "application/octet-stream" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `${r.status}`);
    return j as { id: string; words: number };
  },
  addImage: async (path: string, file: Blob, name: string) => {
    const r = await fetch(`/api/image?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`, { method: "POST", body: file, credentials: "same-origin", headers: { "content-type": "application/octet-stream" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `${r.status}`);
    return j as { rel: string; reused: boolean };
  },
  quit: () => call("POST", "/api/quit", {}),
  recent: () => call<{ recent: Array<{ path: string; action: string; at: string }> }>("GET", "/api/recent"),
  newDraft: (dir: string, title: string, name: string) => call<{ path: string }>("POST", "/api/new", { dir, title, name }),
  templates: () => call<{ templates: Array<{ id: string; label: string }>; pandoc: string }>("GET", "/api/templates"),
  importDocx: (file: File, dir: string) => upload<{ path: string; report: ImportReport }>(`/api/import?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, file),
  exportDocx: (path: string, text: string, o: ExportOptions) => call<ExportReport>("POST", "/api/export", { path, text, ...o }),
  reveal: (path: string) => call("POST", "/api/reveal", { path }),
  workspaceFile: (path: string) => call<{ path: string; content: string }>("GET", `/api/workspace-file?path=${encodeURIComponent(path)}`),
};
