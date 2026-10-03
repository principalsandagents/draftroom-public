// Jev signals: one pass over the open draft. Gate, select, cache, call, flag, and replace the
// draft's Jev comments with the complete current set. Card text comes from jev-signals.yaml;
// Jev supplies numbers only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { callJev, jevKey, JevError, type JevAnswer } from "../engines/jev.ts";
import { eligibleParagraphs, hashText, type Eligible } from "./select.ts";
import { readJevState, writeJevState, decisionKey, type JevDraftState } from "./state.ts";
import { loadContext } from "../context.ts";
import { loadComments, writeSidecar, replaceCards } from "../store.ts";
import { draftPathAllowed, REPO, type Profile } from "../profile.ts";
import type { Comment } from "../../shared/types.ts";
import { locateBlock } from "../../shared/doc.ts";

export interface JevQuestion {
  key: string;
  type: "noul" | "score" | "choice";
  instructions: string;
  criteria?: unknown;
  flag: { above?: number; below?: number; score_below?: number };
  should_at?: number;
  requires?: string[];
  min_sentences?: number;
  combine?: "no_citation";
  title: string;
  hint: string;
  enabled: boolean;
}

export interface JevConfig {
  version: number;
  model: string;
  price_per_million_input: number;
  budget: { per_pass: number; per_day: number; concurrency: number };
  trial: { graduate_after: number; precision: number; retire_below: number };
  questions: JevQuestion[];
}

// The profile's own questions (an organisation's positions, say), merged after the built-in set.
let extraQuestionsFile: string | undefined;
export function configureJev(file: string | undefined): void {
  extraQuestionsFile = file;
}

export function loadJevConfig(file = process.env.DRAFTROOM_JEV_CONFIG ?? path.join(REPO, "perspectives", "jev-signals.yaml"), extra = extraQuestionsFile): JevConfig {
  const c = YAML.parse(fs.readFileSync(file, "utf8")) as JevConfig;
  if (typeof c.version !== "number" || !Array.isArray(c.questions)) throw new Error("jev-signals.yaml: needs version and questions");
  if (extra) {
    const more = (YAML.parse(fs.readFileSync(extra, "utf8")) ?? []) as JevQuestion[];
    if (!Array.isArray(more)) throw new Error(`${path.basename(extra)}: needs a list of questions`);
    const keys = new Set(c.questions.map((q) => q.key));
    for (const q of more) if (keys.has(q.key)) throw new Error(`${path.basename(extra)}: question ${q.key} repeats a built-in key`);
    c.questions.push(...more);
  }
  for (const q of c.questions) {
    if (!q.key || !q.type || !q.title || !q.hint || !q.flag) throw new Error(`jev-signals.yaml: question ${q.key ?? "?"} is missing key, type, title, hint or flag`);
  }
  return c;
}

// ---------------------------------------------------------------- gate

export function gateReason(prof: Profile, draftPath: string, text: string, state: JevDraftState): string | null {
  const ok = draftPathAllowed(prof, draftPath);
  if (!ok.ok) return `Off for this draft: ${ok.why}`;
  if (draftPath.split(path.sep).includes("partnerships")) return "Off for this draft: it sits in a partnerships folder";
  const { context } = loadContext(draftPath, text);
  if (context.sensitivity?.length) return `Off for this draft: its Context marks it ${context.sensitivity.join(", ")}`;
  const k = jevKey();
  if (k.status === "missing" || k.status === "empty") return "Key missing: paste it into ~/.draftroom/jev.key";
  if (k.status === "insecure") return "Key file is readable by others: run chmod 600 ~/.draftroom/jev.key";
  if (!state.enabled) return "Switched off for this draft";
  return null;
}

// ---------------------------------------------------------------- usage

function home(): string {
  return process.env.DRAFTROOM_HOME ?? path.join(os.homedir(), ".draftroom");
}

function logUsage(row: Record<string, unknown>) {
  fs.appendFileSync(path.join(home(), "usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), engine: "jev", ...row }) + "\n", { mode: 0o600 });
}

export function jevUsageToday(): { calls: number; tokens: number } {
  const f = path.join(home(), "usage.jsonl");
  if (!fs.existsSync(f)) return { calls: 0, tokens: 0 };
  const today = new Date().toISOString().slice(0, 10);
  let calls = 0;
  let tokens = 0;
  for (const ln of fs.readFileSync(f, "utf8").split("\n")) {
    if (!ln.startsWith(`{"at":"${today}`) || !ln.includes('"engine":"jev"')) continue;
    try {
      const r = JSON.parse(ln);
      calls++;
      tokens += r.input_tokens ?? 0;
    } catch {
      /* skip */
    }
  }
  return { calls, tokens };
}

// ---------------------------------------------------------------- trial

export interface QuestionStatus {
  key: string;
  title: string;
  enabled: boolean;
  trial: boolean;
  outcomes: number;
  precision: number | null;
  retire: boolean;
}

export function questionStatus(cfg: JevConfig, state: JevDraftState): QuestionStatus[] {
  return cfg.questions.map((q) => {
    let resolved = 0;
    let disagree = 0;
    for (const [k, d] of Object.entries(state.decisions)) {
      if (!k.startsWith(`${q.key}|`)) continue;
      if (d.outcome === "resolved") resolved++;
      if (d.outcome === "disagree") disagree++;
    }
    const n = resolved + disagree;
    const precision = n ? resolved / n : null;
    return {
      key: q.key, title: q.title, enabled: q.enabled !== false, outcomes: n, precision,
      trial: n < cfg.trial.graduate_after || (precision ?? 0) < cfg.trial.precision,
      retire: n >= cfg.trial.graduate_after && (precision ?? 1) < cfg.trial.retire_below,
    };
  });
}

// ---------------------------------------------------------------- flags

function applicable(q: JevQuestion, p: Eligible, st: Record<string, unknown>): boolean {
  if (q.enabled === false) return false;
  if (q.min_sentences && p.sentence_count < q.min_sentences) return false;
  for (const r of q.requires ?? []) if (!st[r]) return false;
  return true;
}

function questionPayload(q: JevQuestion): Record<string, unknown> {
  const out: Record<string, unknown> = { type: q.type, instructions: q.instructions };
  if (q.criteria !== undefined) out.criteria = q.criteria;
  return out;
}

export function evaluateFlag(q: JevQuestion, a: JevAnswer, p: Eligible): { flagged: boolean; strong: boolean; line: string } {
  if (q.type === "noul") {
    const v = a.noul ?? 0.5;
    if (q.combine === "no_citation" && p.has_citation) return { flagged: false, strong: false, line: "" };
    if (q.flag.above !== undefined) {
      const flagged = v >= q.flag.above;
      return { flagged, strong: flagged && q.should_at !== undefined && v >= q.should_at, line: `Jev: ${v.toFixed(2)} (flags at ${q.flag.above.toFixed(2)})` };
    }
    if (q.flag.below !== undefined) {
      const flagged = v < q.flag.below;
      return { flagged, strong: flagged && q.should_at !== undefined && v < q.should_at, line: `Jev: ${v.toFixed(2)} (flags below ${q.flag.below.toFixed(2)})` };
    }
  }
  if (q.type === "score" && q.flag.score_below !== undefined) {
    const v = a.score ?? 99;
    const top = Math.max(0, ...(Array.isArray(q.criteria) ? [q.criteria.length - 1] : [0]));
    const flagged = v < q.flag.score_below;
    return { flagged, strong: flagged && q.should_at !== undefined && v < q.should_at, line: `Jev score: ${v.toFixed(2)} of ${top} (flags below ${q.flag.score_below.toFixed(1)}; confidence ${(a.confidence ?? 0).toFixed(2)})` };
  }
  return { flagged: false, strong: false, line: "" };
}

export function jevCommentId(q: string, hash: string, version: number): string {
  return `jev-${q}-${hash}-v${version}`;
}

/** jev-<question>-<hash>-v<version> → parts, for recording outcomes. */
export function parseJevCommentId(id: string): { q: string; hash: string; version: number } | null {
  const m = /^jev-([a-z_]+)-([0-9a-f]{16})-v(\d+)$/.exec(id);
  return m ? { q: m[1], hash: m[2], version: Number(m[3]) } : null;
}

// ---------------------------------------------------------------- the pass

export interface PassResult {
  ok: boolean;
  reason?: string;
  paragraphs: number;
  scored: number;
  cached: number;
  flagged: number;
  skipped_budget: number;
  model: string | null;
  error?: string;
}

const running = new Map<string, Promise<PassResult>>();
const pending = new Map<string, { prof: Profile; text: string }>();

/** One pass at a time per draft; a request during a pass runs once more afterwards with the latest text. */
export function scorePass(prof: Profile, draftPath: string, text: string): Promise<PassResult> {
  const cur = running.get(draftPath);
  if (cur) {
    pending.set(draftPath, { prof, text });
    return cur;
  }
  const p = doPass(prof, draftPath, text).finally(() => {
    running.delete(draftPath);
    const next = pending.get(draftPath);
    if (next) {
      pending.delete(draftPath);
      void scorePass(next.prof, draftPath, next.text);
    }
  });
  running.set(draftPath, p);
  return p;
}

async function doPass(prof: Profile, draftPath: string, text: string): Promise<PassResult> {
  const cfg = loadJevConfig();
  const state = readJevState(draftPath);
  const base: PassResult = { ok: false, paragraphs: 0, scored: 0, cached: 0, flagged: 0, skipped_budget: 0, model: state.last_model ?? null };
  const reason = gateReason(prof, draftPath, text, state);
  if (reason) return { ...base, reason };

  const { context } = loadContext(draftPath, text);
  const paras = eligibleParagraphs(text);
  const lastModel: string | null = state.last_model ?? null;
  const today = jevUsageToday();
  let budgetLeft = Math.max(0, Math.min(cfg.budget.per_pass, cfg.budget.per_day - today.calls));

  type Job = { p: Eligible; st: Record<string, unknown>; qs: JevQuestion[]; key: string };
  const jobs: Job[] = [];
  const keep = new Set<string>();
  const results = new Map<string, Record<string, JevAnswer>>();
  let cached = 0;
  for (const p of paras) {
    const st: Record<string, unknown> = {
      paragraph: p.cleaned, first_sentence: p.first_sentence, last_sentence: p.last_sentence,
      sentence_count: p.sentence_count, has_citation: p.has_citation,
    };
    if (context.audience) st.audience = context.audience;
    if (context.frame) st.frame = context.frame;
    const qs = cfg.questions.filter((q) => applicable(q, p, st));
    if (!qs.length) continue;
    const key = hashText(JSON.stringify([cfg.version, cfg.model, context.audience ?? "", context.frame ?? "", p.cleaned, qs.map((q) => q.key)]));
    keep.add(key);
    const hit = state.cache[key];
    if (hit && (!lastModel || hit.model === lastModel)) {
      results.set(p.hash, hit.answers);
      cached++;
    } else {
      jobs.push({ p, st, qs, key });
    }
  }

  let scored = 0;
  let skipped = 0;
  let error: string | undefined;
  let model = lastModel;
  const queue = [...jobs];
  const worker = async () => {
    for (;;) {
      const j = queue.shift();
      if (!j) return;
      if (budgetLeft <= 0) {
        skipped++;
        continue;
      }
      budgetLeft--;
      try {
        const r = await callJev(cfg.model, j.st, Object.fromEntries(j.qs.map((q) => [q.key, questionPayload(q)])));
        model = r.model;
        state.cache[j.key] = { model: r.model, answers: r.answers, at: new Date().toISOString() };
        results.set(j.p.hash, r.answers);
        scored++;
        logUsage({ draft: path.basename(draftPath), input_tokens: r.usage.input_tokens, model: r.model, questions: j.qs.length });
      } catch (e) {
        error = e instanceof JevError ? e.message : `Jev call failed: ${(e as Error).message}`;
        logUsage({ draft: path.basename(draftPath), error });
        if (e instanceof JevError && (e.kind === "rejected" || e.kind === "key" || e.kind === "config")) queue.length = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.budget.concurrency) }, worker));

  // Prune the cache to current paragraphs; remember the model that answered.
  for (const k of Object.keys(state.cache)) if (!keep.has(k)) delete state.cache[k];
  state.last_model = model;
  writeJevState(draftPath, state);

  const flagged = replaceJevComments(draftPath, text, cfg, paras, results, state);
  return { ok: !error, paragraphs: paras.length, scored, cached, flagged, skipped_budget: skipped, model, error };
}

/**
 * Rebuild the draft's Jev comments from the complete current results. Removes every Jev comment
 * (so deleted or rewritten paragraphs leave nothing behind), then adds open flags, skipping any
 * the writer has already resolved or dismissed for this paragraph and question version.
 */
export function replaceJevComments(draftPath: string, text: string, cfg: JevConfig, paras: Eligible[], results: Map<string, Record<string, JevAnswer>>, state: JevDraftState): number {
  const sc = loadComments(draftPath, text);
  const statuses = new Map(questionStatus(cfg, state).map((s) => [s.key, s]));
  const fresh: Comment[] = [];
  const now = new Date().toISOString();
  for (const p of paras) {
    const answers = results.get(p.hash);
    if (!answers) continue;
    for (const q of cfg.questions) {
      const a = answers[q.key];
      if (!a || q.enabled === false) continue;
      const f = evaluateFlag(q, a, p);
      if (!f.flagged) continue;
      if (state.decisions[decisionKey(q.key, p.hash, cfg.version)]) continue;
      const exact = text.slice(p.start, p.end);
      const where = locateBlock(text, p.start);
      fresh.push({
        id: jevCommentId(q.key, p.hash, cfg.version), perspective: "jev", engine: "jev", run_id: `jev-${now.slice(0, 10)}`,
        level: "paragraph", severity: f.strong ? "should" : "consider", kind: "check",
        anchor: {
          exact, prefix: text.slice(Math.max(0, p.start - 30), p.start), suffix: text.slice(p.end, p.end + 30),
          start: p.start, end: p.end, section: where.section, paragraph: where.paragraph,
        },
        scope: "paragraph", title: q.title, rationale: f.line, hint: q.hint, links: [], proposed_source: null, example: null,
        status: "open", dismiss_reason: null, stale: false, flags: ["jev", ...(statuses.get(q.key)?.trial ? ["trial"] : [])], created: now,
      });
    }
  }
  replaceCards(sc, (c) => c.engine === "jev", fresh);
  const n = fresh.length;
  sc.summaries.jev = { summary: `${n} signal${n === 1 ? "" : "s"} across ${paras.length} prose paragraph${paras.length === 1 ? "" : "s"}.`, run_id: `jev-${now.slice(0, 10)}`, engine: "jev", at: now };
  writeSidecar(draftPath, sc);
  return n;
}

/** Record the writer's outcome on a Jev comment so the flag stays quiet and precision is tracked. */
export function recordJevOutcome(draftPath: string, commentId: string, outcome: "resolved" | "intentional" | "disagree" | "out of scope" | null) {
  const parts = parseJevCommentId(commentId);
  if (!parts) return;
  const state = readJevState(draftPath);
  const k = decisionKey(parts.q, parts.hash, parts.version);
  if (outcome) state.decisions[k] = { outcome, at: new Date().toISOString() };
  else delete state.decisions[k];
  writeJevState(draftPath, state);
}

export function setJevEnabled(draftPath: string, enabled: boolean, consent?: string) {
  const state = readJevState(draftPath);
  state.enabled = enabled;
  if (enabled) {
    state.enabled_at = new Date().toISOString();
    if (consent) state.consent = consent;
  }
  writeJevState(draftPath, state);
}

export const CONSENT_TEXT =
  "Draftroom will send this draft's prose paragraphs, with the audience and frame from Context, to api.typesafe.ai for Jev signals. Headings, quotes, tables, lists, notes, the Prep block and anything outside this draft are never sent. TypeSafe has not published a retention statement for its direct API.";
