// A Claude run with a JSON schema for Citations, through the same engine as the reviewers.

import fs from "node:fs";
import path from "node:path";
import { engines, RUNS, newRunId } from "../runs.ts";
import { EngineError } from "../engines/types.ts";

export async function claudeJson(name: string, prompt: string, schema: object, timeoutMs = 240_000): Promise<unknown> {
  const runId = newRunId(name);
  const runDir = path.join(RUNS, runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runDir, "input.md"), prompt, { mode: 0o600 });
  const out = await engines.claude({ runDir, prompt, schema, tools: [], addDirs: [], web: false, timeoutMs });
  if (!out.output || typeof out.output !== "object") throw new EngineError("Claude returned nothing usable", "bad-output");
  return out.output;
}
