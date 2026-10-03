// Codex adapter: spawns the unmodified `codex exec` on the writer's ChatGPT login.
// Read-only sandbox, ephemeral session, user config ignored, -C on the clean run dir.
// Never --add-dir (it grants write access) and never --search (a Codex web run could read
// local files and put them into a search query).

import fs from "node:fs";
import path from "node:path";
import { run, looksRateLimited } from "./pool.ts";
import { EngineError, type EngineInput, type EngineOutput } from "./types.ts";

export const CODEX_BIN = process.env.DRAFTROOM_CODEX ?? "codex";

export function codexArgv(i: Pick<EngineInput, "runDir" | "model">): string[] {
  const argv = [
    "exec",
    "--sandbox", "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-C", i.runDir,
    "--output-schema", path.join(i.runDir, "schema.json"),
    "-o", path.join(i.runDir, "out.json"),
  ];
  if (i.model) argv.push("-m", i.model);
  argv.push("-");
  return argv;
}

export async function runCodex(i: EngineInput): Promise<EngineOutput> {
  if (i.web) throw new EngineError("Codex never runs web passes; use Claude", "failed");
  fs.writeFileSync(path.join(i.runDir, "schema.json"), JSON.stringify(i.schema));
  const argv = codexArgv(i);
  fs.writeFileSync(path.join(i.runDir, "argv.json"), JSON.stringify(["codex", ...argv]));
  const outFile = path.join(i.runDir, "out.json");
  let r = await run(CODEX_BIN, argv, { cwd: i.runDir, stdin: i.prompt, timeoutMs: i.timeoutMs, signal: i.signal });
  if (r.code !== 0 && !r.killed && looksRateLimited(r)) {
    await new Promise((res) => setTimeout(res, 30_000));
    r = await run(CODEX_BIN, argv, { cwd: i.runDir, stdin: i.prompt, timeoutMs: i.timeoutMs, signal: i.signal });
  }
  if (r.stderr) fs.writeFileSync(path.join(i.runDir, "stderr.txt"), r.stderr);
  if (r.killed) throw new EngineError(`Codex run timed out after ${Math.round(i.timeoutMs / 1000)}s`, "timeout");
  if (r.code !== 0) {
    if (looksRateLimited(r)) throw new EngineError("Codex usage limit: try later or switch engine", "rate-limit", r.stderr.slice(-500));
    throw new EngineError(`Codex exited ${r.code}`, "failed", r.stderr.slice(-500));
  }
  if (!fs.existsSync(outFile)) throw new EngineError("Codex wrote no output file", "bad-output", r.stderr.slice(-500));
  const raw = fs.readFileSync(outFile, "utf8");
  let out: unknown;
  try {
    out = JSON.parse(raw);
  } catch {
    throw new EngineError("Codex output was not JSON", "bad-output", raw.slice(0, 500));
  }
  const used = /tokens used\s*\n?\s*([\d,]+)/i.exec(r.stderr);
  return { output: out, secs: r.secs, usage: used ? { total_tokens: Number(used[1].replace(/,/g, "")) } : undefined, raw };
}
