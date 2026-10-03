// Recently used drafts: the last ten opened, saved, created or imported, newest first.
// Stored in ~/.draftroom/recent.json; only paths that still exist and pass the draft policy are listed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { draftPathAllowed, type Profile } from "./profile.ts";

export type RecentAction = "opened" | "edited" | "created" | "imported";
export interface RecentEntry {
  path: string;
  action: RecentAction;
  at: string;
}

export const MAX_RECENT = 10;

function file(): string {
  return path.join(process.env.DRAFTROOM_HOME ?? path.join(os.homedir(), ".draftroom"), "recent.json");
}

function read(): RecentEntry[] {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as RecentEntry[];
  } catch {
    return [];
  }
}

export function touchRecent(p: string, action: RecentAction): void {
  const list = read().filter((e) => e.path !== p);
  list.unshift({ path: p, action, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  // Keep a few spare so files deleted since still leave ten to show.
  fs.writeFileSync(file(), JSON.stringify(list.slice(0, MAX_RECENT * 2), null, 1), { mode: 0o600 });
}

export function listRecent(prof: Profile): RecentEntry[] {
  return read()
    .filter((e) => fs.existsSync(e.path) && draftPathAllowed(prof, e.path).ok)
    .slice(0, MAX_RECENT);
}
