// Claude adapter: spawns the unmodified `claude` binary in print mode on the writer's own login.
// Isolation per Step 0 (spike/RESULTS.md): --safe-mode disables CLAUDE.md, skills, plugins,
// hooks, MCP and custom agents; --restricted ignores settings files and confines file tools
// to the working directories. Never --bare: it refuses OAuth.

import fs from "node:fs";
import path from "node:path";
import { run, looksRateLimited } from "./pool.ts";
import { EngineError, type EngineInput, type EngineOutput } from "./types.ts";

export const CLAUDE_BIN = process.env.DRAFTROOM_CLAUDE ?? "claude";
const FILE_TOOLS = new Set(["Read", "Grep", "Glob"]);

export function claudeArgv(i: Pick<EngineInput, "schema" | "tools" | "addDirs" | "web" | "model">): string[] {
  // The web pass gets web tools and no file tools, so it cannot open local files.
  const tools = i.web ? ["WebSearch", "WebFetch"] : i.tools.filter((t) => FILE_TOOLS.has(t));
  const argv = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(i.schema),
    "--tools", tools.length ? tools.join(",") : "",
    "--permission-mode", "dontAsk",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (i.model) argv.push("--model", i.model);
  if (!i.web) for (const d of i.addDirs) argv.push(`--add-dir=${d}`);
  return argv;
}

export async function runClaude(i: EngineInput): Promise<EngineOutput> {
  const argv = claudeArgv(i);
  fs.writeFileSync(path.join(i.runDir, "argv.json"), JSON.stringify(["claude", ...argv.map((a, k) => (argv[k - 1] === "--json-schema" ? "<schema>" : a))]));
  let r = await run(CLAUDE_BIN, argv, { cwd: i.runDir, stdin: i.prompt, timeoutMs: i.timeoutMs, signal: i.signal });
  if (r.code !== 0 && !r.killed && looksRateLimited(r)) {
    await new Promise((res) => setTimeout(res, 30_000));
    r = await run(CLAUDE_BIN, argv, { cwd: i.runDir, stdin: i.prompt, timeoutMs: i.timeoutMs, signal: i.signal });
  }
  fs.writeFileSync(path.join(i.runDir, "stdout.json"), r.stdout);
  if (r.stderr) fs.writeFileSync(path.join(i.runDir, "stderr.txt"), r.stderr);
  if (r.killed) throw new EngineError(`Claude run timed out after ${Math.round(i.timeoutMs / 1000)}s`, "timeout");
  if (r.code !== 0 && looksRateLimited(r)) throw new EngineError("Claude quota limit: try later or switch engine", "rate-limit", r.stderr.slice(-500));
  let j: any;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new EngineError(`Claude returned no JSON (exit ${r.code})`, "failed", (r.stderr || r.stdout).slice(-500));
  }
  if (j.is_error) {
    const msg = String(j.result ?? j.subtype ?? "error");
    throw new EngineError(`Claude error: ${msg.slice(0, 200)}`, /limit/i.test(msg) ? "rate-limit" : "failed", msg);
  }
  let out = j.structured_output;
  if (out === undefined && typeof j.result === "string") {
    // Fallback: JSON in the text result.
    const m = /\{[\s\S]*\}/.exec(j.result);
    if (m) out = JSON.parse(m[0]);
  }
  if (out === undefined) throw new EngineError("Claude returned no structured output", "bad-output", String(j.result ?? "").slice(0, 500));
  return { output: out, secs: r.secs, usage: j.usage, cost_usd: j.total_cost_usd, raw: r.stdout };
}
