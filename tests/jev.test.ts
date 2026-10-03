// Jev signals: classifier, engine and scoring pass, against a fake TypeSafe. No network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "./helpers.ts";

const sb = sandbox();
process.env.DRAFTROOM_HOME = sb.home;
// A fixed copy of the question set, so tuning perspectives/jev-signals.yaml cannot break these tests.
process.env.DRAFTROOM_JEV_CONFIG = path.join(import.meta.dirname, "fixtures", "jev", "signals.yaml");
const FAKE_KEY = "apik_test_SECRET_1234567890"; // gitleaks:allow (a fake key for tests)
let select: typeof import("../server/jev/select.ts");
let engine: typeof import("../server/engines/jev.ts");
let signals: typeof import("../server/jev/signals.ts");
let state: typeof import("../server/jev/state.ts");
let store: typeof import("../server/store.ts");
let profile: typeof import("../server/profile.ts");
let calls: Array<{ url: string; headers: any; body: any }> = [];
let answer: (q: string, body: any) => any;

const P = (s: string) => s; // readability
const DRAFT = `---
title: "Jev test"
---

<!-- body -->

## A heading that must never be sent because headings are skipped

Most organisations now use AI in at least one function, and the share grew from 2024 to 2026 across every sector we looked at. This is a long enough paragraph to qualify for checks.

Boards should act on this before regulators do. They have the duty, the information and the time, and waiting costs more than acting now in almost every case we have seen [^FN01-abcd].

> A blockquote that may quote a standard or a newsletter and must never be sent anywhere at all, however long it is.

| Table | Must not be sent |
|---|---|
| a | b |

- A list item that should not be sent even though it is long enough to qualify on words alone here.

Short one. Too short.

[^FN01-abcd]: The note text, never sent.
`;

function writeKey(k = FAKE_KEY) {
  fs.mkdirSync(sb.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(sb.home, 0o700);
  fs.writeFileSync(path.join(sb.home, "jev.key"), `${k}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(sb.home, "jev.key"), 0o600);
}

beforeAll(async () => {
  select = await import("../server/jev/select.ts");
  engine = await import("../server/engines/jev.ts");
  signals = await import("../server/jev/signals.ts");
  state = await import("../server/jev/state.ts");
  store = await import("../server/store.ts");
  profile = await import("../server/profile.ts");
  fs.writeFileSync(sb.draft, DRAFT);
});

beforeEach(() => {
  calls = [];
  answer = (q) => (q === "audience_fit" || q === "frame_fit" ? { type: "score", score: 1.8, confidence: 0.9, legend: {}, probabilities: {} } : { type: "noul", noul: 0.1 });
  engine.setFetch((async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    const answers = Object.fromEntries(Object.keys(body.questions).map((q) => [q, answer(q, body)]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 300, output_tokens: 20 } }), { status: 200 });
  }) as any);
  writeKey();
});

describe("classifier", () => {
  it("sends only body prose paragraphs of 25+ words and 2+ sentences", () => {
    const ps = select.eligibleParagraphs(DRAFT);
    expect(ps).toHaveLength(2);
    const all = ps.map((p) => p.cleaned).join(" ");
    for (const never of ["heading", "blockquote", "Table", "list item", "note text", "Short one"]) expect(all).not.toContain(never);
  });
  it("neutralises note references and detects citations in code", () => {
    const ps = select.eligibleParagraphs(DRAFT);
    expect(ps[1].cleaned).toContain("[n]");
    expect(ps[1].cleaned).not.toContain("FN01");
    expect(ps[1].has_citation).toBe(true);
    expect(ps[0].has_citation).toBe(false);
  });
  it("splits sentences around abbreviations and decimals", () => {
    expect(select.sentences("Prof. Smith said 3.5 per cent. That is e.g. high. Done.")).toEqual(["Prof. Smith said 3.5 per cent.", "That is e.g. high.", "Done."]);
  });
  it("never sends the Prep block or quoted-material blocks", () => {
    const t = `---\ntitle: x\n---\n## Prep\n\nThis prep paragraph is long enough to qualify on words and has two sentences in it. It must never be sent.\n\n<!-- body -->\n\n<!-- tell-lint: quoted -->\nA quoted paragraph from a paid newsletter long enough to qualify on words. It has two sentences too.\n<!-- /tell-lint: quoted -->\n`;
    expect(select.eligibleParagraphs(t)).toHaveLength(0);
  });
});

describe("engine", () => {
  it("sends Bearer key, model and the questions to the TypeSafe endpoint", async () => {
    const r = await engine.callJev("jev-latest", { paragraph: "x" }, { q: { type: "noul", instructions: "y" } });
    expect(r.model).toBe("jev-1.13.0");
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(calls[0].body).toEqual({ model: "jev-latest", state: { paragraph: "x" }, questions: { q: { type: "noul", instructions: "y" } } });
  });
  it("refuses missing, empty and insecure keys without calling", async () => {
    fs.writeFileSync(path.join(sb.home, "jev.key"), "  \n");
    await expect(engine.callJev("m", {}, {})).rejects.toThrow(/empty/);
    writeKey();
    fs.chmodSync(path.join(sb.home, "jev.key"), 0o644);
    expect(engine.jevKey().status).toBe("insecure");
    expect(calls).toHaveLength(0);
  });
  it("refuses a non-https endpoint override", async () => {
    process.env.DRAFTROOM_JEV_URL = "http://evil.example/v1/systemone";
    await expect(engine.callJev("m", {}, {})).rejects.toThrow(/https/);
    delete process.env.DRAFTROOM_JEV_URL;
  });
  it("maps 401 and 422, and never puts the key in an error", async () => {
    engine.setFetch((async () => new Response("{}", { status: 401 })) as any);
    const e1 = await engine.callJev("m", {}, {}).catch((e) => e);
    expect(e1.message).toMatch(/rejected the key/);
    engine.setFetch((async () => new Response(JSON.stringify({ detail: [{ msg: "bad criteria" }] }), { status: 422 })) as any);
    const e2 = await engine.callJev("m", {}, {}).catch((e) => e);
    expect(e2.message).toMatch(/bad criteria/);
    engine.setFetch((async () => { throw new Error(`boom ${FAKE_KEY}`); }) as any);
    const e3 = await engine.callJev("m", {}, {}).catch((e) => e);
    expect(e3.message).not.toContain(FAKE_KEY);
  });
});

describe("scoring pass", () => {
  const prof = () => profile.loadProfile(sb.profPath);
  it("refuses a draft that is not switched on, even when asked directly", async () => {
    state.writeJevState(sb.draft, { enabled: false, enabled_at: null, consent: null, cache: {}, decisions: {} });
    const r = await signals.scorePass(prof(), sb.draft, DRAFT);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Switched off/);
    expect(calls).toHaveLength(0);
  });
  it("refuses drafts whose Context lists a sensitivity flag", async () => {
    signals.setJevEnabled(sb.draft, true, "consent");
    const ctx = await import("../server/context.ts");
    ctx.saveContext(sb.draft, { sensitivity: ["partnership"] });
    const r = await signals.scorePass(prof(), sb.draft, DRAFT);
    expect(r.reason).toMatch(/partnership/);
    expect(calls).toHaveLength(0);
    fs.rmSync(ctx.contextPath(sb.draft));
  });
  it("scores eligible paragraphs, sends only classifier fields, caches, and flags with fixed card text", async () => {
    signals.setJevEnabled(sb.draft, true, "consent");
    answer = (q) => (q === "unsupported_claim" ? { type: "noul", noul: 0.93 } : q === "states_fact" ? { type: "noul", noul: 0.95 } : q.endsWith("_fit") ? { type: "score", score: 1.8, confidence: 0.9, legend: {}, probabilities: {} } : { type: "noul", noul: 0.5 });
    const r = await signals.scorePass(prof(), sb.draft, DRAFT);
    expect(r.ok).toBe(true);
    expect(r.scored).toBe(2);
    for (const c of calls) {
      expect(Object.keys(c.body.state).sort()).toEqual(["first_sentence", "has_citation", "last_sentence", "paragraph", "sentence_count"]);
      expect(c.body.questions.frame_fit).toBeUndefined(); // no frame in Context
      expect(c.body.questions.audience_fit).toBeUndefined(); // no audience
    }
    const jev = store.readSidecar(sb.draft).comments.filter((c) => c.engine === "jev");
    const titles = jev.map((c) => c.title).sort();
    // states_fact flags only the paragraph without a citation; unsupported_claim flags both.
    expect(titles).toEqual(["Claim without support", "Claim without support", "Fact without a source"]);
    expect(jev.every((c) => c.flags.includes("jev") && c.flags.includes("trial"))).toBe(true);
    expect(jev.find((c) => c.title === "Fact without a source")!.severity).toBe("should");
    expect(jev.find((c) => c.title === "Claim without support")!.hint).toMatch(/^Support the claim/);
    calls = [];
    const again = await signals.scorePass(prof(), sb.draft, DRAFT);
    expect(again.cached).toBe(2);
    expect(calls).toHaveLength(0);
  });
  it("re-sends only an edited paragraph and removes cards for a deleted one", async () => {
    calls = [];
    const edited = DRAFT.replace("Boards should act on this before regulators do.", "Boards should act on this soon.");
    await signals.scorePass(prof(), sb.draft, edited);
    expect(calls).toHaveLength(1);
    const deleted = edited.replace(/Most organisations[\s\S]*?checks\.\n/, "");
    await signals.scorePass(prof(), sb.draft, deleted);
    const jev = store.readSidecar(sb.draft).comments.filter((c) => c.engine === "jev");
    expect(jev.every((c) => !c.anchor!.exact.startsWith("Most organisations"))).toBe(true);
    expect(Object.keys(store.readSidecar(sb.draft).dropped).filter((k) => k.startsWith("jev"))).toHaveLength(0);
  });
  it("keeps a dismissed flag quiet and counts it toward precision", async () => {
    answer = (q) => (q === "unsupported_claim" ? { type: "noul", noul: 0.93 } : q.endsWith("_fit") ? { type: "score", score: 1.8, confidence: 0.9, legend: {}, probabilities: {} } : { type: "noul", noul: 0.5 });
    const current = DRAFT.replace(/Most organisations[\s\S]*?checks\.\n/, "").replace("Boards should act on this before regulators do.", "Boards should act on this soon.");
    const st = state.readJevState(sb.draft);
    st.cache = {};
    state.writeJevState(sb.draft, st);
    await signals.scorePass(prof(), sb.draft, current);
    const jev = store.readSidecar(sb.draft).comments.filter((c) => c.engine === "jev");
    expect(jev.length).toBeGreaterThan(0);
    const target = jev[0];
    signals.recordJevOutcome(sb.draft, target.id, "disagree");
    const text = fs.readFileSync(sb.draft, "utf8");
    await signals.scorePass(prof(), sb.draft, DRAFT.replace(/Most organisations[\s\S]*?checks\.\n/, "").replace("Boards should act on this before regulators do.", "Boards should act on this soon."));
    const after = store.readSidecar(sb.draft).comments.filter((c) => c.engine === "jev");
    expect(after.some((c) => c.id === target.id)).toBe(false);
    const qs = signals.questionStatus(signals.loadJevConfig(), state.readJevState(sb.draft));
    const q = qs.find((x) => target.id.startsWith(`jev-${x.key}-`))!;
    expect(q.outcomes).toBe(1);
    expect(q.precision).toBe(0);
    void text;
  });
  it("never writes the key anywhere Draftroom stores data", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== "jev.key" && fs.readFileSync(p, "utf8").includes(FAKE_KEY)) hits.push(p);
      }
    };
    walk(sb.root);
    expect(hits).toEqual([]);
  });
});

describe("profile questions", () => {
  it("merges extra questions after the built-in set and refuses a repeated key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-extra-"));
    const extra = path.join(dir, "extra.yaml");
    fs.writeFileSync(extra, "- key: org_position\n  type: noul\n  instructions: x\n  flag: { above: 0.6 }\n  title: Org position\n  hint: Check it.\n  enabled: true\n");
    const base = signals.loadJevConfig(undefined, undefined);
    const merged = signals.loadJevConfig(undefined, extra);
    expect(merged.questions.length).toBe(base.questions.length + 1);
    expect(merged.questions.at(-1)!.key).toBe("org_position");
    fs.writeFileSync(extra, `- key: ${base.questions[0].key}\n  type: noul\n  instructions: x\n  flag: { above: 0.6 }\n  title: t\n  hint: h\n`);
    expect(() => signals.loadJevConfig(undefined, extra)).toThrow(/repeats a built-in key/);
  });
});
