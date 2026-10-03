// The engine contract. Perspectives never know which CLI ran them.

export interface EngineInput {
  runDir: string; // clean directory under ~/.draftroom/runs/
  prompt: string;
  schema: object;
  tools: string[]; // Claude tool names; ignored by Codex
  addDirs: string[]; // read-only folders, already policy-checked (Claude only)
  web: boolean; // Claude WebSearch/WebFetch only; Codex never searches
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface EngineOutput {
  output: unknown; // schema-shaped, validated by the caller
  secs: number;
  usage?: Record<string, unknown>;
  cost_usd?: number;
  raw: string;
}

export class EngineError extends Error {
  constructor(message: string, public kind: "rate-limit" | "timeout" | "failed" | "bad-output", public detail = "") {
    super(message);
  }
}
