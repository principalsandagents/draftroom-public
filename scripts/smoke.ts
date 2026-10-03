// One small real run per engine through the full pipeline, in a sandbox copy of a fixture.
// Spends a little subscription quota. Run after any claude or codex update.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { sandbox } from "../tests/helpers.ts";

const sb = sandbox();
process.env.DRAFTROOM_HOME = sb.home;
const { startRun, initHome } = await import("../server/runs.ts");
const { loadProfile } = await import("../server/profile.ts");
const { readSidecar } = await import("../server/store.ts");

for (const [bin, args] of [["claude", ["--version"]], ["codex", ["--version"]]] as const) {
  try {
    console.log(`${bin}: ${execFileSync(bin, [...args], { encoding: "utf8" }).trim()}`);
  } catch (e) {
    console.log(`${bin}: NOT FOUND (${(e as Error).message})`);
  }
}

initHome();
const prof = loadProfile(sb.profPath);
const text = fs.readFileSync(sb.draft, "utf8");
const at = text.indexOf("Voluntary guidance");
let failed = 0;
for (const [perspective, engine] of [["line-voice", "claude"], ["copy-proof", "codex"]] as const) {
  const t0 = Date.now();
  const r = await startRun(prof, { path: sb.draft, perspective, scope: "paragraph", engine, from: at, to: at, text });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`${perspective} on ${engine}: ${r.ok ? "OK" : "FAILED"} in ${secs}s: ${r.message}`);
  if (r.dropped_reasons.length) console.log(`  dropped: ${r.dropped_reasons.join("; ")}`);
  if (!r.ok) failed++;
}
for (const c of readSidecar(sb.draft).comments) console.log(`  [${c.perspective}/${c.engine}] ${c.severity} · ${c.title} · ${c.hint}`);
fs.rmSync(sb.root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
