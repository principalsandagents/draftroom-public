import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.ts";
import { addComments, readSidecar, loadComments, sidecarPath } from "../server/store.ts";
import { configureContext, importFromDraft, loadContext, saveContext } from "../server/context.ts";
import type { Comment } from "../shared/types.ts";

const sb = sandbox();

function mk(exact: string, text: string): Comment {
  const start = text.indexOf(exact);
  return {
    id: `t-${start}`, perspective: "argument", engine: "claude", run_id: "r1", level: "argument", severity: "should", kind: "direction",
    anchor: { exact, prefix: text.slice(Math.max(0, start - 30), start), suffix: text.slice(start + exact.length, start + exact.length + 30), start, end: start + exact.length, section: "", paragraph: 0 },
    scope: "document", title: "t", rationale: "r", hint: "h", links: [], proposed_source: null, example: null, status: "open", dismiss_reason: null, stale: false, flags: [], created: "",
  };
}

describe("sidecar store", () => {
  it("writes beside the draft in .draftroom and re-anchors after edits", () => {
    const text = fs.readFileSync(sb.draft, "utf8");
    const c = mk("The contract is therefore where obligations are set", text);
    addComments(sb.draft, text, [c], { perspective: "argument", summary: "s", run_id: "r1", engine: "claude", dropped: 0, scope: "document", from: 0, to: text.length });
    expect(sidecarPath(sb.draft)).toContain("/.draftroom/");
    const edited = text.replace("## Why procurement matters", "## Why procurement matters\n\nA new paragraph added above.");
    const sc = loadComments(sb.draft, edited);
    const a = sc.comments[0].anchor!;
    expect(edited.slice(a.start, a.end)).toBe(c.anchor!.exact);
    expect(sc.comments[0].stale).toBe(false);
    const rewritten = edited.replace("where obligations are set", "where duties land");
    expect(loadComments(sb.draft, rewritten).comments[0].stale).toBe(true);
  });
  it("sets the sidecar folder to owner-only", () => {
    readSidecar(sb.draft);
    const mode = fs.statSync(sidecarPath(sb.draft).replace(/\/[^/]+$/, "")).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("article context", () => {
  it("imports from Substack frontmatter and prep", () => {
    const text = fs.readFileSync(sb.draft, "utf8");
    configureContext({ "example-newsletter": { publication: "Example Substack", voice: "personal" } });
    const c = importFromDraft(sb.draft, text);
    configureContext(undefined);
    expect(c.format).toBe("substack-take");
    expect(c.publication).toMatch(/Substack/);
    expect(c.voice).toBe("personal");
    expect(c.audience).toMatch(/procurement leads/);
    expect(c.purpose).toMatch(/three questions/);
    expect(c.key_claim).toBe("Procurement shapes AI use more than policy does.");
    expect(c.sources_file).toBe(`${sb.postDir}/sources.md`);
  });
  it("imports a frame from frontmatter or a Prep line", () => {
    const fm = "---\ntitle: x\nframe: International, Australia as the worked example\n---\nBody.";
    expect(importFromDraft(sb.draft, fm).frame).toBe("International, Australia as the worked example");
    const prep = "---\ntitle: x\n---\n## Prep\n\n- **Frame:** UK and EU\n\n<!-- body -->\nBody.";
    expect(importFromDraft(sb.draft, prep).frame).toBe("UK and EU");
  });
  it("saved fields win over imported ones", () => {
    const text = fs.readFileSync(sb.draft, "utf8");
    saveContext(sb.draft, { audience: "Agency CIOs" });
    expect(loadContext(sb.draft, text).context.audience).toBe("Agency CIOs");
    expect(loadContext(sb.draft, text).context.format).toBe("substack-take");
  });
  it("rejects an invalid context", () => {
    expect(() => saveContext(sb.draft, { format: "novel" as any })).toThrow(/invalid/);
  });
});

describe("closed history", () => {
  const meta = (text: string, scope: Comment["scope"] = "document") => ({ perspective: "argument", summary: "s", run_id: "r2", engine: "claude" as const, dropped: 0, scope, from: 0, to: text.length });
  it("a resolved comment is not raised again on a rerun, and records when it was closed", async () => {
    const { updateComment } = await import("../server/store.ts");
    fs.rmSync(sidecarPath(sb.draft), { force: true });
    const text = fs.readFileSync(sb.draft, "utf8");
    const c = { ...mk("The contract is therefore where obligations are set", text), id: "a1", title: "Unsupported claim about contracts" };
    addComments(sb.draft, text, [c], meta(text));
    const sc = updateComment(sb.draft, text, "a1", { status: "resolved" });
    expect(sc.comments.find((x) => x.id === "a1")!.closed_at).toBeTruthy();
    const again = { ...c, id: "a2", title: "Claim about contracts is unsupported" };
    const other = { ...mk("The contract is therefore where obligations are set", text), id: "a3", title: "Sentence too long", hint: "Split it" };
    const r = addComments(sb.draft, text, [again, other], meta(text));
    expect(r.held).toBe(1);
    expect(r.sc.comments.map((x) => x.id).sort()).toEqual(["a1", "a3"]);
  });
  it("a rerun clears stale open comments and old whole-draft points, but a paragraph run keeps whole-draft points", () => {
    fs.rmSync(sidecarPath(sb.draft), { force: true });
    const text = fs.readFileSync(sb.draft, "utf8");
    const stale = { ...mk("The contract is therefore where obligations are set", text), id: "s1" };
    const whole = { ...mk("x", text), id: "w1", anchor: null, title: "Whole-draft point" };
    addComments(sb.draft, text, [stale, whole], meta(text));
    const edited = text.replace("where obligations are set", "where duties land");
    const para = addComments(sb.draft, edited, [], { ...meta(edited, "paragraph"), from: 0, to: 5 });
    expect(para.sc.comments.map((x) => x.id)).toEqual(["w1"]);
    const doc = addComments(sb.draft, edited, [], meta(edited, "section"));
    expect(doc.sc.comments).toEqual([]);
  });
});

describe("citation style for reviewers", () => {
  it("tells reviewers the chosen style", async () => {
    const { writeCiteState, readCiteState } = await import("../server/cite/state.ts");
    const { citationStyleNote } = await import("../server/runs.ts");
    expect(citationStyleNote(sb.draft)).toBeNull();
    writeCiteState(sb.draft, { ...readCiteState(sb.draft), style: "aglc4" });
    expect(citationStyleNote(sb.draft)).toMatch(/AGLC4.*Do not suggest another order/s);
  });
});
