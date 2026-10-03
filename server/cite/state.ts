// Per-draft citation state: .draftroom/<draft>.cite.json

import fs from "node:fs";
import path from "node:path";
import { sidecarDir } from "../store.ts";

export interface QuoteCheck {
  quote: string;
  label: string | null;
  status: "exact" | "close" | "not_found" | "not_checked";
  detail: string;
  source: string | null; // URL or linked file name
  library_id: string | null;
  checked_at: string;
}

export interface CiteState {
  style: "aglc4" | "chicago18" | "apa7" | null;
  parse_cache?: Record<string, unknown>; // note-text hash -> segments from Claude
  formatted?: { style: string; order_key: string; at: string }; // last accepted formatting
  validation?: Record<string, unknown>; // Release C: per note suffix
  links: Record<string, string>; // note label suffix -> library id (linked files)
  sources: Record<string, string>; // note label suffix -> library id (fetched)
  quotes: QuoteCheck[];
}

export function citeStatePath(draft: string): string {
  return path.join(sidecarDir(draft), `${path.basename(draft).replace(/\.md$/i, "")}.cite.json`);
}

export function readCiteState(draft: string): CiteState {
  try {
    return { style: null, links: {}, sources: {}, quotes: [], ...JSON.parse(fs.readFileSync(citeStatePath(draft), "utf8")) };
  } catch {
    return { style: null, links: {}, sources: {}, quotes: [] };
  }
}

export function writeCiteState(draft: string, s: CiteState) {
  fs.mkdirSync(sidecarDir(draft), { recursive: true, mode: 0o700 });
  fs.writeFileSync(citeStatePath(draft), JSON.stringify(s, null, 1), { mode: 0o600 });
}

/** Note labels keep their suffix through renumbering: FN03-ab12 -> ab12. */
export function suffixOf(label: string): string {
  return /-([a-z0-9]+)$/.exec(label)?.[1] ?? label;
}
