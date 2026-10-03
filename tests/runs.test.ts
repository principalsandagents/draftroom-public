import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { sandbox } from "./helpers.ts";
import type { AgentOutput } from "../shared/types.ts";

const sb = sandbox();
process.env.DRAFTROOM_HOME = sb.home;
let runs: typeof import("../server/runs.ts");
let profile: typeof import("../server/profile.ts");
let store: typeof import("../server/store.ts");

beforeAll(async () => {
  runs = await import("../server/runs.ts");
  profile = await import("../server/profile.ts");
  store = await import("../server/store.ts");
  runs.initHome();
});

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "engine-output", "argument.json"), "utf8")) as AgentOutput;

describe("a model run with a fake engine", () => {
  it("anchors, guards, drops and stores", async () => {
    const prof = profile.loadProfile(sb.profPath);
    let seenArgs: any = null;
    runs.engines.claude = async (i) => {
      seenArgs = i;
      return { output: fixture, secs: 1, raw: "" };
    };
    const text = fs.readFileSync(sb.draft, "utf8");
    const r = await runs.startRun(prof, { path: sb.draft, perspective: "argument", scope: "document", text });
    expect(r.ok).toBe(true);
    // 6 comments: 1 invented quote dropped, 2 guardrail drops (rewrite, colon wording) = 3 kept + 1 doc point.
    expect(r.dropped).toBe(3);
    expect(r.added).toBe(4);
    expect(r.dropped_reasons.some((x) => x.startsWith("quote not found"))).toBe(true);
    const sc = store.readSidecar(sb.draft);
    const titles = sc.comments.map((c) => c.title);
    expect(titles).toContain("Causal claim without support");
    expect(titles).toContain("Close does not return to the claim");
    const causal = sc.comments.find((c) => c.title === "Causal claim without support")!;
    expect(text.slice(causal.anchor!.start, causal.anchor!.end)).toBe(causal.anchor!.exact);
    expect(causal.anchor!.section).toBe("Why procurement matters");
    expect(sc.summaries.argument.summary).toMatch(/procurement claim/);
    // Draft untouched.
    expect(fs.readFileSync(sb.draft, "utf8")).toBe(text);
    expect(seenArgs.web).toBe(false);
  });

  it("replaces open comments in range on rerun and keeps dismissed ones", async () => {
    const prof = profile.loadProfile(sb.profPath);
    const text = fs.readFileSync(sb.draft, "utf8");
    const sc = store.readSidecar(sb.draft);
    const first = sc.comments.find((c) => c.title === "Unsourced claim")!;
    store.updateComment(sb.draft, text, first.id, { status: "dismissed", dismiss_reason: "intentional" });
    let prompt = "";
    runs.engines.claude = async (i) => {
      prompt = i.prompt;
      return { output: fixture, secs: 1, raw: "" };
    };
    await runs.startRun(prof, { path: sb.draft, perspective: "argument", scope: "document", text });
    const after = store.readSidecar(sb.draft);
    expect(after.comments.filter((c) => c.status === "open" && c.title === "Causal claim without support")).toHaveLength(1);
    expect(after.comments.filter((c) => c.status === "dismissed")).toHaveLength(1);
    expect(prompt).toContain("Already resolved or dismissed by the writer");
    expect(prompt).toContain("Unsourced claim");
  });

  it("rejects a scope the perspective does not allow", async () => {
    const prof = profile.loadProfile(sb.profPath);
    const text = fs.readFileSync(sb.draft, "utf8");
    await expect(runs.startRun(prof, { path: sb.draft, perspective: "argument", scope: "paragraph", text, from: 500 })).rejects.toThrow(/does not run at paragraph/);
  });

  it("reports a schema failure without storing anything", async () => {
    const prof = profile.loadProfile(sb.profPath);
    const text = fs.readFileSync(sb.draft, "utf8");
    runs.engines.claude = async () => ({ output: { summary: "x" }, secs: 1, raw: "" });
    const before = store.readSidecar(sb.draft).comments.length;
    const r = await runs.startRun(prof, { path: sb.draft, perspective: "line-voice", scope: "section", text, from: text.indexOf("Voluntary") });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/schema/);
    expect(store.readSidecar(sb.draft).comments.length).toBe(before);
  });

  it("gives Evidence its sources file and read-only folders, never web", async () => {
    const prof = profile.loadProfile(sb.profPath);
    const text = fs.readFileSync(sb.draft, "utf8");
    let input: any;
    runs.engines.claude = async (i) => {
      input = i;
      return { output: { summary: "ok", doc_points: [], comments: [] }, secs: 1, raw: "" };
    };
    await runs.startRun(prof, { path: sb.draft, perspective: "evidence", scope: "section", text, from: text.indexOf("Voluntary") });
    expect(input.web).toBe(false);
    expect(input.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(input.addDirs).toContain(sb.postDir);
    expect(input.addDirs).toContain(prof.positions_dir);
    expect(input.prompt).toContain("Department of Finance policy 2024");
  });

  it("runs Lint with no engine", async () => {
    const prof = profile.loadProfile(sb.profPath);
    const text = fs.readFileSync(sb.draft, "utf8");
    runs.engines.claude = async () => {
      throw new Error("lint must not call a model");
    };
    const r = await runs.startRun(prof, { path: sb.draft, perspective: "lint", scope: "document", text });
    expect(r.ok).toBe(true);
    const lint = store.readSidecar(sb.draft).comments.filter((c) => c.perspective === "lint");
    expect(lint.some((c) => c.title === "Long sentence (43 words)" || c.title.startsWith("Long sentence"))).toBe(true);
    for (const c of lint) expect(text.slice(c.anchor!.start, c.anchor!.end)).toBe(c.anchor!.exact);
  });
});

describe("line brief", () => {
  it("Line and voice sends the voice card and the brief, not the long references, and no frontmatter", async () => {
    const prof = profile.loadProfile(sb.profPath);
    let prompt = "";
    runs.engines.claude = async (i) => { prompt = i.prompt; return { output: { summary: "ok", doc_points: [], comments: [] }, secs: 1, raw: "" }; };
    const text = fs.readFileSync(sb.draft, "utf8");
    await runs.startRun(prof, { path: sb.draft, perspective: "line-voice", scope: "section", text, from: text.indexOf("Voluntary") });
    expect(prompt).toContain("Line brief: what to look for");
    expect(prompt).toContain("Write like this");
    expect(prompt).not.toContain("Pre-delivery check");
    expect(prompt).not.toContain("sha1:");
    expect(prompt.length).toBeLessThan(20000); // about 5,000 tokens; the long references alone were about 49,000 characters
  });
  it("warns when a distilled file's sources change", () => {
    expect(profile.profileWarnings(profile.loadProfile(sb.profPath))).toEqual([]);
  });
});

describe("author tokens", () => {
  it("fill reviewer instructions from the profile and never touch draft text", () => {
    const prof = profile.loadProfile(sb.profPath);
    const named = { ...prof, author: { name: "Sam Writer", short: "Sam", org: "ACME" } };
    expect(profile.personalise(named, "for {{author.name}}{{author.description}}; {{author.org}}'s view")).toBe("for Sam Writer; ACME's view");
    expect(profile.personalise({ ...prof, author: undefined }, "{{author.short}} writes")).toBe("the writer writes");
    expect(() => profile.personalise(prof, "{{author.age}}")).toThrow(/unknown token/);
  });
});

describe("Line and voice on the whole draft", () => {
  it("runs at document scope with the higher comment cap", async () => {
    const prof = profile.loadProfile(sb.profPath);
    let prompt = "";
    runs.engines.claude = async (i) => { prompt = i.prompt; return { output: { summary: "ok", doc_points: [], comments: [] }, secs: 1, raw: "" }; };
    const text = fs.readFileSync(sb.draft, "utf8");
    const r = await runs.startRun(prof, { path: sb.draft, perspective: "line-voice", scope: "document", text });
    expect(r.ok).toBe(true);
    expect(prompt).toContain("Return at most 25 comments");
  });
});

describe("default profile", () => {
  it("picks the one real profile and ignores other YAML in profiles/", async () => {
    const saved = process.env.DRAFTROOM_PROFILE;
    const savedHome = process.env.DRAFTROOM_HOME;
    delete process.env.DRAFTROOM_PROFILE;
    process.env.DRAFTROOM_HOME = sb.home;
    const own = fs.readdirSync(path.join(profile.REPO, "profiles")).filter((f) => f.endsWith(".yaml") && f !== "example.yaml" && !!YAML.parse(fs.readFileSync(path.join(profile.REPO, "profiles", f), "utf8"))?.files);
    expect(profile.profileName()).toBe(own.length === 1 ? own[0].replace(/\.yaml$/, "") : "example");
    if (saved) process.env.DRAFTROOM_PROFILE = saved;
    process.env.DRAFTROOM_HOME = savedHome;
  });
});
