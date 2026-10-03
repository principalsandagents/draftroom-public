// Per-draft Jev file: .draftroom/<draft>.jev.json. Holds the on/off switch (enforced by the
// server), the consent shown, the answer cache, and the writer's outcomes on Jev flags.

import fs from "node:fs";
import path from "node:path";
import { sidecarDir } from "../store.ts";
import type { JevAnswer } from "../engines/jev.ts";

export interface JevDraftState {
  enabled: boolean;
  enabled_at: string | null;
  consent: string | null;
  cache: Record<string, { model: string; answers: Record<string, JevAnswer>; at: string }>;
  // key: question|paragraphHash|version → outcome
  decisions: Record<string, { outcome: "resolved" | "intentional" | "disagree" | "out of scope"; at: string }>;
  last_model?: string | null; // the model that last answered; cache entries from another model are refreshed
}

export function jevStatePath(draftPath: string): string {
  return path.join(sidecarDir(draftPath), `${path.basename(draftPath).replace(/\.md$/i, "")}.jev.json`);
}

export function readJevState(draftPath: string): JevDraftState {
  try {
    return { enabled: false, enabled_at: null, consent: null, cache: {}, decisions: {}, ...JSON.parse(fs.readFileSync(jevStatePath(draftPath), "utf8")) };
  } catch {
    return { enabled: false, enabled_at: null, consent: null, cache: {}, decisions: {} };
  }
}

export function writeJevState(draftPath: string, s: JevDraftState): void {
  fs.mkdirSync(sidecarDir(draftPath), { recursive: true, mode: 0o700 });
  const p = jevStatePath(draftPath);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
}

export function decisionKey(question: string, paragraphHash: string, version: number): string {
  return `${question}|${paragraphHash}|${version}`;
}
