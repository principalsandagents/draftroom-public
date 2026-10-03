// TypeSafe Jev client: POST /v1/systemone with the writer's key from ~/.draftroom/jev.key.
// The key is read on each call, trimmed, and never logged, returned or written anywhere.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const JEV_URL_DEFAULT = "https://api.typesafe.ai/v1/systemone";

export function keyPath(): string {
  return path.join(process.env.DRAFTROOM_HOME ?? path.join(os.homedir(), ".draftroom"), "jev.key");
}

export type KeyStatus = "missing" | "empty" | "insecure" | "ok";

export function jevKey(): { status: KeyStatus; key?: string } {
  const p = keyPath();
  if (!fs.existsSync(p)) return { status: "missing" };
  const st = fs.statSync(p);
  const dirMode = fs.statSync(path.dirname(p)).mode & 0o777;
  if ((st.mode & 0o077) !== 0 || (dirMode & 0o077) !== 0) return { status: "insecure" };
  const key = fs.readFileSync(p, "utf8").trim();
  if (!key) return { status: "empty" };
  return { status: "ok", key };
}

/** The endpoint: https anywhere, or http only to localhost (tests). Anything else is refused. */
export function jevUrl(): string {
  const u = process.env.DRAFTROOM_JEV_URL ?? JEV_URL_DEFAULT;
  const parsed = new URL(u);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new JevError("DRAFTROOM_JEV_URL must be https (or http to localhost)", "config");
  return u;
}

export class JevError extends Error {
  constructor(message: string, public kind: "key" | "rejected" | "invalid" | "rate" | "network" | "timeout" | "config" | "response") {
    super(message);
  }
}

export interface JevAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setFetch(f: Fetch | null) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Check the fields Draftroom uses (the 3.1 schema's discriminators make full validation awkward). */
function checkResponse(j: any, questions: Record<string, { type: string }>): JevResponse {
  if (!j || typeof j.model !== "string" || typeof j.answers !== "object" || typeof j.usage?.input_tokens !== "number") {
    throw new JevError("unexpected response from TypeSafe", "response");
  }
  for (const [k, q] of Object.entries(questions)) {
    const a = j.answers[k];
    if (!a || a.type !== q.type) throw new JevError(`no ${q.type} answer for ${k}`, "response");
    if (a.type === "noul" && typeof a.noul !== "number") throw new JevError(`noul answer for ${k} has no probability`, "response");
    if (a.type === "score" && (typeof a.score !== "number" || typeof a.confidence !== "number")) throw new JevError(`score answer for ${k} incomplete`, "response");
    if (a.type === "choice" && (typeof a.choice !== "string" || typeof a.confidence !== "number")) throw new JevError(`choice answer for ${k} incomplete`, "response");
  }
  return j as JevResponse;
}

export async function callJev(model: string, state: unknown, questions: Record<string, any>, timeoutMs = 15_000): Promise<JevResponse> {
  const k = jevKey();
  if (k.status !== "ok") throw new JevError(`Jev key ${k.status}`, "key");
  const url = jevUrl();
  const body = JSON.stringify({ model, state, questions });
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" }, body, signal: ctl.signal });
    } catch (e) {
      clearTimeout(t);
      if ((e as Error).name === "AbortError") throw new JevError("TypeSafe did not answer within 15 seconds", "timeout");
      throw new JevError(`could not reach TypeSafe (${(e as Error).message.replace(k.key!, "***")})`, "network");
    }
    clearTimeout(t);
    if (r.status === 429 && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new JevError("TypeSafe rejected the key", "rejected");
    if (r.status === 429) throw new JevError("TypeSafe rate limit: try again shortly", "rate");
    if (r.status === 422) {
      const j: any = await r.json().catch(() => ({}));
      throw new JevError(`TypeSafe refused the request: ${j?.detail?.[0]?.msg ?? "invalid"}`, "invalid");
    }
    if (!r.ok) throw new JevError(`TypeSafe error ${r.status}`, "network");
    return checkResponse(await r.json(), questions);
  }
}
