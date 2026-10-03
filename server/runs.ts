// A run: slice the scope, assemble the prompt, call an engine, validate, anchor, guard, store.
// Nothing here writes to the draft file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import Ajv from "ajv";
import { locate, contextAround } from "./anchor.ts";
import { guardComment, exampleOverlaps } from "./guard.ts";
import { addComments, closedFor, loadComments, updateComment } from "./store.ts";
import { readCiteState } from "./cite/state.ts";
import { loadContext, contextForPrompt } from "./context.ts";
import { loadPerspectives, preamble, type Perspective } from "./perspectives.ts";
import { verifiedQuotesForPrompt } from "./cite/check.ts";
import { personalise, profileText, readPathAllowed, type Profile } from "./profile.ts";
import { runClaude } from "./engines/claude.ts";
import { runCodex } from "./engines/codex.ts";
import { EngineError, type EngineInput, type EngineOutput } from "./engines/types.ts";
import { lintFindings, readabilityFindings, runTellLint, lintCommentTexts, relocateHits } from "./engines/lint.ts";
import { Cancelled } from "./engines/pool.ts";
import { blockAt, bodyStart, locateBlock, outline } from "../shared/doc.ts";
import type { AgentOutput, Comment, EngineName, Example, RunEvent, RunRequest, Scope } from "../shared/types.ts";
import agentSchema from "../shared/schema/agent-output.schema.json" with { type: "json" };
import exampleSchema from "../shared/schema/example-output.schema.json" with { type: "json" };

export const HOME = process.env.DRAFTROOM_HOME ?? path.join(os.homedir(), ".draftroom");
export const RUNS = path.join(HOME, "runs");
const USAGE = path.join(HOME, "usage.jsonl");
const RUN_RETENTION_DAYS = 14;
export const EXAMPLES_PER_DAY = Number(process.env.DRAFTROOM_EXAMPLES_PER_DAY ?? 10);

export const events = new EventEmitter();
const controllers = new Map<string, AbortController>();

const ajv = new Ajv({ allErrors: true, strict: false });
const validateAgent = ajv.compile(agentSchema as object);
const validateExample = ajv.compile(exampleSchema as object);

// Engines are swappable for tests.
export const engines: Record<"claude" | "codex", (i: EngineInput) => Promise<EngineOutput>> = {
  claude: runClaude,
  codex: runCodex,
};

export function initHome(): void {
  fs.mkdirSync(RUNS, { recursive: true, mode: 0o700 });
  fs.chmodSync(HOME, 0o700);
  fs.chmodSync(RUNS, 0o700);
  const cutoff = Date.now() - RUN_RETENTION_DAYS * 86400_000;
  for (const d of fs.readdirSync(RUNS)) {
    const p = path.join(RUNS, d);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function emit(e: RunEvent) {
  events.emit("event", e);
}

export function cancelAll(): number {
  for (const c of controllers.values()) c.abort();
  return controllers.size;
}

export function cancelRun(runId: string): boolean {
  const c = controllers.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

export function newRunId(perspective: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${perspective}-${crypto.randomBytes(2).toString("hex")}`;
}

/** Resolve the range a run covers. `from`/`to` are the cursor or selection. */
export function scopeRange(text: string, scope: Scope, from = 0, to = from): { from: number; to: number; section: string } {
  if (scope === "document") return { from: bodyStart(text), to: text.length, section: "" };
  if (scope === "selection") {
    if (to <= from) throw new Error("selection scope needs a selection");
    return { from, to, section: locateBlock(text, from).section };
  }
  const r = blockAt(text, from, scope === "paragraph" ? "paragraph" : "section");
  if (!r) throw new Error(`no ${scope} at the cursor`);
  return r;
}

function usageLog(row: Record<string, unknown>) {
  fs.appendFileSync(USAGE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 });
}

export function usageToday(): Record<string, number> {
  if (!fs.existsSync(USAGE)) return {};
  const today = new Date().toISOString().slice(0, 10);
  const out: Record<string, number> = {};
  for (const ln of fs.readFileSync(USAGE, "utf8").split("\n")) {
    if (!ln.startsWith(`{"at":"${today}`)) continue;
    try {
      const r = JSON.parse(ln);
      const k = r.mode === "example" ? "examples" : r.engine;
      out[k] = (out[k] ?? 0) + 1;
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Estimated input tokens for a run, shown before the writer clicks Run. */
export function estimateTokens(prof: Profile, p: Perspective, text: string, scope: Scope, from?: number, to?: number): number {
  if (p.engine === "lint") return 0;
  let chars = preamble().length + p.body.length + outline(text).length;
  for (const k of p.profile_files) chars += profileText(prof, k).length;
  try {
    const r = scopeRange(text, scope, from, to);
    chars += (r.to - r.from) * (scope === "paragraph" ? 3 : 1);
  } catch {
    chars += text.length;
  }
  return Math.round(chars / 4);
}

interface Built {
  prompt: string;
  addDirs: string[];
  sourceText: string; // draft plus reference text the run saw, for the guardrail
}

function buildPrompt(prof: Profile, p: Perspective, draftPath: string, text: string, range: { from: number; to: number; section: string }, scope: Scope): Built {
  const { context } = loadContext(draftPath, text);
  const parts: string[] = [personalise(prof, preamble())];
  parts.push(`## Your perspective\n\n${personalise(prof, p.body)}`);
  for (const k of p.profile_files) {
    if (k === "standing_positions") parts.push(profileText(prof, k));
    else parts.push(`## Profile: ${k.replace(/_/g, " ")}\n\n${profileText(prof, k)}`);
  }
  let sourceText = text;
  const addDirs: string[] = [];
  if (p.id === "evidence") {
    const sf = context.sources_file;
    if (sf) {
      const ok = readPathAllowed(prof, sf, [path.dirname(draftPath)]);
      if (ok.ok && fs.existsSync(ok.real!)) {
        const s = fs.readFileSync(ok.real!, "utf8");
        parts.push(`## Sources file (${ok.real})\n\n${s}`);
        sourceText += "\n" + s;
      }
    } else {
      parts.push("## Sources file\n\n(None set. Treat every factual claim as unsourced unless a footnote gives the source.)");
    }
    const dirs = [path.dirname(draftPath), ...(prof.positions_dir ? [prof.positions_dir] : []), ...(context.reference_folders ?? [])];
    for (const d of dirs) {
      const ok = readPathAllowed(prof, d, [path.dirname(draftPath)]);
      if (ok.ok && !addDirs.includes(ok.real!)) addDirs.push(ok.real!);
    }
    const positions = prof.positions_dir
      ? personalise(prof, `{{author.org}} positions records are in ${prof.positions_dir}; each file lists records with a status. Only \`approved\` records may be presented as {{author.org}}'s position.`)
      : "No positions folder is configured: flag any statement of an organisation's position that the sources file does not support.";
    parts.push(`## Folders you may read (Read, Grep, Glob)\n\n${addDirs.map((d) => `- ${d}`).join("\n")}\n\n${positions}`);
  }
  const sc = loadComments(draftPath, text);
  const dismissed = closedFor(sc, p.id);
  if (p.id === "evidence") {
    const verified = verifiedQuotesForPrompt(draftPath);
    if (verified.length) parts.push(`## Quotes already verified against their sources by Draftroom (do not flag these as unverifiable)\n\n${verified.join("\n")}`);
  }
  parts.push(`## Article context\n\n${contextForPrompt(context)}`);
  const cite = citationStyleNote(draftPath);
  if (cite) parts.push(cite);
  parts.push(`## Outline of the whole draft\n\n${outline(text)}`);
  if (dismissed.length) parts.push(`## Already resolved or dismissed by the writer (do not raise these again, in any wording)\n\n${dismissed.join("\n")}`);

  let scoped = text.slice(range.from, range.to);
  if (scope === "paragraph") {
    const before = blockAt(text, Math.max(0, range.from - 2), "paragraph");
    const after = blockAt(text, Math.min(text.length, range.to + 2), "paragraph");
    const ctxBefore = before && before.to <= range.from ? text.slice(before.from, before.to) : "";
    const ctxAfter = after && after.from >= range.to ? text.slice(after.from, after.to) : "";
    if (ctxBefore) parts.push(`## Paragraph before (context only, do not comment)\n\n${ctxBefore}`);
    if (ctxAfter) parts.push(`## Paragraph after (context only, do not comment)\n\n${ctxAfter}`);
  }
  parts.push(`## Scope: ${scope}${range.section ? ` (section "${range.section}")` : ""}. Return at most ${capFor(p, scope)} comments and 3 doc_points, most important first.\n\n=== TEXT UNDER REVIEW ===\n${scoped}\n=== END TEXT UNDER REVIEW ===`);
  return { prompt: parts.join("\n\n---\n\n"), addDirs, sourceText };
}

const STYLE_NAME: Record<string, string> = {
  aglc4: "AGLC4 (Australian Guide to Legal Citation, 4th edition), in footnotes",
  chicago18: "Chicago Manual of Style, 18th edition, notes and bibliography",
  apa7: "APA 7th edition, author-date in text with a reference list",
};

/** The draft's chosen citation style, so reviewers check notes against it and not a style of their own. */
export function citationStyleNote(draftPath: string): string | null {
  const st = readCiteState(draftPath);
  if (!st.style) return null;
  const done = st.formatted?.style === st.style ? ` Draftroom formatted the notes in this style on ${st.formatted.at.slice(0, 10)}.` : "";
  return `## Citation style\n\nNick has chosen ${STYLE_NAME[st.style] ?? st.style}.${done} Judge notes against this style only: flag a note that lacks an element the style needs (author, title, date, publisher or web address) or departs from the style. Do not suggest another order or format.`;
}

function mkRunDir(runId: string): string {
  const d = path.join(RUNS, runId);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function nowIso() {
  return new Date().toISOString();
}

export interface RunResult {
  run_id: string;
  ok: boolean;
  message: string;
  added: number;
  dropped: number;
  dropped_reasons: string[];
}

export async function startRun(prof: Profile, req: RunRequest): Promise<RunResult> {
  const perspectives = loadPerspectives();
  const p = perspectives.find((x) => x.id === req.perspective);
  if (!p) throw new Error(`unknown perspective ${req.perspective}`);
  if (p.runnable === false) throw new Error(`${p.name} has nothing to run`);
  if (req.mode === "example") return exampleRun(prof, p, req);
  if (!p.scopes.includes(req.scope)) throw new Error(`${p.name} does not run at ${req.scope} scope`);
  const engine = (p.engine === "lint" ? "lint" : req.engine === "codex" ? "codex" : req.engine === "claude" ? "claude" : p.engine) as "lint" | "claude" | "codex";
  const runId = newRunId(p.id);
  const text = req.text;
  const range = scopeRange(text, req.scope, req.from, req.to);
  const t0 = Date.now();
  emit({ type: "run-start", run_id: runId, perspective: p.id, engine, scope: req.scope, path: req.path });

  const finish = (r: RunResult) => {
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    emit({ type: "run-end", run_id: runId, perspective: p.id, ok: r.ok, message: r.message, added: r.added, dropped: r.dropped, secs, path: req.path });
    return r;
  };

  try {
    if (engine === "lint") return finish(lintRun(prof, p, req, runId, range));
    const built = buildPrompt(prof, p, req.path, text, range, req.scope);
    const runDir = mkRunDir(runId);
    fs.writeFileSync(path.join(runDir, "input.md"), built.prompt, { mode: 0o600 });
    const ctl = new AbortController();
    controllers.set(runId, ctl);
    let out: EngineOutput;
    try {
      out = await engines[engine]({
        runDir, prompt: built.prompt, schema: agentSchema, tools: p.tools, addDirs: built.addDirs, web: false,
        timeoutMs: (p.id === "evidence" || req.scope === "document" ? 360 : 240) * 1000, signal: ctl.signal,
      });
    } finally {
      controllers.delete(runId);
    }
    if (!validateAgent(out.output)) {
      throw new EngineError(`output failed the schema: ${ajv.errorsText(validateAgent.errors).slice(0, 200)}`, "bad-output");
    }
    const res = processOutput(prof, p, req, runId, engine, range, out.output as AgentOutput, built.sourceText);
    usageLog({ run_id: runId, perspective: p.id, engine, scope: req.scope, chars_in: built.prompt.length, secs: out.secs, usage: out.usage, cost_usd: out.cost_usd, added: res.added, dropped: res.dropped });
    return finish(res);
  } catch (e) {
    const msg = e instanceof Cancelled ? "Cancelled" : e instanceof EngineError ? e.message : `Run failed: ${(e as Error).message}`;
    usageLog({ run_id: runId, perspective: p.id, engine, scope: req.scope, error: msg });
    return finish({ run_id: runId, ok: false, message: msg, added: 0, dropped: 0, dropped_reasons: [] });
  }
}

/** Comment cap: whole-draft runs may have a higher one. */
export function capFor(p: Perspective, scope: Scope): number {
  return scope === "document" && p.max_comments_document ? p.max_comments_document : p.max_comments;
}

function lintRun(prof: Profile, p: Perspective, req: RunRequest, runId: string, range: { from: number; to: number }): RunResult {
  if (!prof.tell_lint) return { run_id: runId, ok: false, message: "Lint is off: the profile sets no tell_lint script", added: 0, dropped: 0, dropped_reasons: [] };
  const slice = req.text.slice(range.from, range.to);
  const hits = relocateHits(prof.python ?? "python3", prof.tell_lint, slice, runTellLint(prof.python ?? "python3", prof.tell_lint, slice));
  const findings = [...lintFindings(slice, hits), ...readabilityFindings(slice)];
  const comments: Comment[] = findings.slice(0, p.max_comments).map((f, i) => {
    const start = range.from + f.start;
    const end = range.from + f.end;
    const where = locateBlock(req.text, start);
    const ctx = contextAround(req.text, start, end);
    return {
      id: `${runId}-${String(i + 1).padStart(2, "0")}`, perspective: p.id, engine: "lint", run_id: runId,
      level: f.level, severity: f.severity, kind: f.kind,
      anchor: { exact: req.text.slice(start, end), prefix: ctx.prefix, suffix: ctx.suffix, start, end, section: where.section, paragraph: where.paragraph },
      scope: req.scope, title: f.title, rationale: f.rationale, hint: f.hint, links: [], proposed_source: null, example: null,
      status: "open", dismiss_reason: null, stale: false, flags: [], created: nowIso(),
    };
  });
  const fails = hits.filter((h) => h.tier === "fail").length;
  const summary = comments.length
    ? `${fails} tell-lint fail${fails === 1 ? "" : "s"}, ${hits.length - fails} warning${hits.length - fails === 1 ? "" : "s"}, ${findings.length - hits.length} readability flag${findings.length - hits.length === 1 ? "" : "s"}.`
    : "Clean: no tell-lint findings and no readability flags.";
  addComments(req.path, req.text, comments, { perspective: p.id, summary, run_id: runId, engine: "lint", dropped: 0, scope: req.scope, from: range.from, to: range.to });
  usageLog({ run_id: runId, perspective: p.id, engine: "lint", scope: req.scope, added: comments.length });
  return { run_id: runId, ok: true, message: summary, added: comments.length, dropped: 0, dropped_reasons: [] };
}

/** Validate anchors, apply the guardrail, lint comment text, and store. Exported for tests. */
export function processOutput(prof: Profile, p: Perspective, req: RunRequest, runId: string, engine: EngineName, range: { from: number; to: number }, out: AgentOutput, sourceText: string): RunResult {
  const text = req.text;
  const kept: Comment[] = [];
  const reasons: string[] = [];
  let n = 0;
  const mkId = () => `${runId}-${String(++n).padStart(2, "0")}`;

  for (const mc of out.comments.slice(0, capFor(p, req.scope))) {
    const loc = locate(text, mc.exact, mc.prefix, mc.suffix, range.from);
    if (!loc) {
      reasons.push(`quote not found: "${mc.exact.slice(0, 50)}"`);
      continue;
    }
    if (loc.end < range.from || loc.start > range.to) {
      reasons.push(`outside scope: "${mc.exact.slice(0, 50)}"`);
      continue;
    }
    const g = guardComment(mc, sourceText);
    if (!g.ok) {
      reasons.push(`guardrail: ${g.reason}`);
      continue;
    }
    const where = locateBlock(text, loc.start);
    const ctx = contextAround(text, loc.start, loc.end);
    const flags = [...g.flags];
    if (loc.method === "fuzzy") flags.push("fuzzy");
    kept.push({
      id: mkId(), perspective: p.id, engine, run_id: runId, level: mc.level, severity: mc.severity, kind: mc.kind,
      anchor: { exact: text.slice(loc.start, loc.end), prefix: ctx.prefix, suffix: ctx.suffix, start: loc.start, end: loc.end, section: where.section, paragraph: where.paragraph },
      scope: req.scope, title: mc.title, rationale: g.rationale, hint: g.hint, links: mc.links ?? [], proposed_source: mc.proposed_source ?? null,
      example: null, status: "open", dismiss_reason: null, stale: false, flags, created: nowIso(),
    });
  }
  for (const d of out.doc_points.slice(0, 3)) {
    const g = guardComment({ hint: d.hint, rationale: d.rationale, level: d.level }, sourceText);
    if (!g.ok) {
      reasons.push(`guardrail (doc point): ${g.reason}`);
      continue;
    }
    kept.push({
      id: mkId(), perspective: p.id, engine, run_id: runId, level: d.level, severity: d.severity, kind: "observation", anchor: null,
      scope: "none", title: d.title, rationale: g.rationale, hint: g.hint, links: [], proposed_source: null, example: null,
      status: "open", dismiss_reason: null, stale: false, flags: g.flags, created: nowIso(),
    });
  }
  // Guardrail rule 3: flag comments whose own text trips tell-lint.
  try {
    if (!prof.tell_lint) throw new Error("no lint");
    const tells = lintCommentTexts(prof.python ?? "python3", prof.tell_lint, kept.map((c) => `${c.rationale} ${c.hint}`));
    kept.forEach((c, i) => tells.has(i) && c.flags.push("tell"));
  } catch {
    /* lint unavailable: comments still useful */
  }
  const { held } = addComments(req.path, text, kept, { perspective: p.id, summary: out.summary, run_id: runId, engine, dropped: reasons.length, scope: req.scope, from: range.from, to: range.to });
  if (reasons.length) fs.writeFileSync(path.join(RUNS, runId, "dropped.json"), JSON.stringify(reasons, null, 2), { mode: 0o600 });
  const added = kept.length - held;
  const msg = `${added} comment${added === 1 ? "" : "s"}${held ? `; ${held} already resolved or dismissed, not shown` : ""}${reasons.length ? `, ${reasons.length} dropped` : ""}`;
  return { run_id: runId, ok: true, message: msg, added, dropped: reasons.length, dropped_reasons: reasons };
}

async function exampleRun(prof: Profile, p: Perspective, req: RunRequest): Promise<RunResult> {
  if (!req.comment_id) throw new Error("example mode needs comment_id");
  if ((usageToday().examples ?? 0) >= EXAMPLES_PER_DAY) {
    return { run_id: "", ok: false, message: `Example limit reached (${EXAMPLES_PER_DAY} a day)`, added: 0, dropped: 0, dropped_reasons: [] };
  }
  const sc = loadComments(req.path, req.text);
  const c = sc.comments.find((x) => x.id === req.comment_id);
  if (!c) throw new Error(`no comment ${req.comment_id}`);
  const engine: "claude" | "codex" = req.engine === "codex" ? "codex" : "claude";
  const runId = newRunId(`${p.id}-example`);
  const runDir = mkRunDir(runId);
  const anchored = c.anchor?.exact ?? "";
  const prompt = [
    personalise(prof, "You are helping {{author.name}} understand a piece of editorial advice by showing the principle on a different sentence. {{author.short}} writes every word of the draft; your example must not be usable in it."),
    profileText(prof, "voice_card"),
    `## The advice\n\nTitle: ${c.title}\nWhy: ${c.rationale}\nDirection: ${c.hint}`,
    `## Rules\n\n- Write a short before-and-after pair (each at most 30 words) on an unrelated topic (for example cooking, sport, urban transport, never AI, governance, boards or technology policy).\n- Do not reuse any four-word sequence from the text below.\n- Format: "Before: … After: …".\n- In \`principle\`, state in one sentence what changed and why it helps the reader.\n- Follow the voice card in the After sentence.\n\nText the advice is about (do not reuse its words or topic):\n${anchored}`,
  ].join("\n\n---\n\n");
  fs.writeFileSync(path.join(runDir, "input.md"), prompt, { mode: 0o600 });
  emit({ type: "run-start", run_id: runId, perspective: p.id, engine, scope: "none", path: req.path });
  const t0 = Date.now();
  const end = (ok: boolean, message: string) => {
    emit({ type: "run-end", run_id: runId, perspective: p.id, ok, message, added: 0, dropped: 0, secs: (Date.now() - t0) / 1000, path: req.path });
    usageLog({ run_id: runId, perspective: p.id, engine, mode: "example", ok, message });
    return { run_id: runId, ok, message, added: 0, dropped: 0, dropped_reasons: [] };
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await engines[engine]({ runDir, prompt, schema: exampleSchema, tools: [], addDirs: [], web: false, timeoutMs: 120_000 });
      if (!validateExample(out.output)) continue;
      const ex = out.output as Example;
      if (anchored && exampleOverlaps(ex.example, anchored)) continue;
      updateComment(req.path, req.text, c.id, { example: ex });
      events.emit("event", { type: "comments-changed", path: req.path } satisfies RunEvent);
      return end(true, "Example ready");
    }
    return end(false, "Could not produce an example that avoids your wording; try again later");
  } catch (e) {
    return end(false, e instanceof EngineError ? e.message : (e as Error).message);
  }
}
