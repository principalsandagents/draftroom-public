// Subprocess pool: concurrency cap, timeouts, cancellation, environment stripping.
// No shell is ever involved: argv arrays only.

import { spawn } from "node:child_process";

export const MAX_CONCURRENT = 3;
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_PROJECT_DIR"];

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  secs: number;
  killed: boolean;
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

let active = 0;
const queue: Array<() => void> = [];

async function slot(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
  active++;
  return () => {
    active--;
    queue.shift()?.();
  };
}

export function activeRuns(): number {
  return active;
}

export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of STRIPPED_ENV) delete env[k];
  return env;
}

export interface SpawnOpts {
  cwd: string;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Run one CLI process inside a pool slot. Detached so cancel kills the whole process group. */
export async function run(cmd: string, argv: string[], o: SpawnOpts): Promise<ProcResult> {
  const release = await slot();
  try {
    if (o.signal?.aborted) throw new Cancelled();
    return await new Promise<ProcResult>((resolve, reject) => {
      const t0 = Date.now();
      const child = spawn(cmd, argv, { cwd: o.cwd, env: cleanEnv(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const kill = () => {
        killed = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(kill, o.timeoutMs);
      const onAbort = () => kill();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (o.signal?.aborted) return reject(new Cancelled());
        resolve({ code, stdout, stderr, secs: (Date.now() - t0) / 1000, killed });
      });
      child.stdin.end(o.stdin);
    });
  } finally {
    release();
  }
}

export function looksRateLimited(r: ProcResult): boolean {
  return /rate.?limit|429|usage limit|too many requests|quota/i.test(r.stderr + r.stdout.slice(-2000));
}
