import { describe, expect, it } from "vitest";
import { guardComment, exampleOverlaps, quotedSpans } from "../server/guard.ts";

const draft = "Voluntary guidance has changed board behaviour across the ASX 200. The contract sets the terms for every vendor.";

describe("guardrail", () => {
  it("drops a quoted 14-word replacement sentence", () => {
    const g = guardComment({ level: "sentence", rationale: "x", hint: "Rewrite as 'Boards rarely change behaviour without enforcement and clear accountability for every single outcome they own.'" }, draft);
    expect(g.ok).toBe(false);
  });
  it("drops the same replacement unquoted after a trigger", () => {
    const g = guardComment({ level: "sentence", rationale: "x", hint: "Rewrite as boards rarely change behaviour without enforcement and clear accountability for every single outcome." }, draft);
    expect(g.ok).toBe(false);
  });
  it("drops an unquoted content sentence with no direction", () => {
    const g = guardComment({ level: "argument", rationale: "x", hint: "Boards rarely change their behaviour without enforcement and clear accountability for every single outcome." }, draft);
    expect(g.ok).toBe(false);
  });
  it("drops wording supplied after a colon", () => {
    const g = guardComment({ level: "argument", rationale: "x", hint: "Consider: boards rarely act without enforcement." }, draft);
    expect(g.ok).toBe(false);
  });
  it("passes a hint that quotes six words of the draft", () => {
    const g = guardComment({ level: "argument", rationale: "A director will ask what shows the guidance caused it.", hint: "Support the sentence starting 'Voluntary guidance has changed board behaviour across…' or narrow it." }, draft);
    expect(g.ok).toBe(true);
  });
  it("passes a mechanics spelling correction", () => {
    const g = guardComment({ level: "mechanics", rationale: "US spelling in an Australian piece.", hint: "Use 'organisation'." }, draft);
    expect(g.ok).toBe(true);
  });
  it("lets a rationale say 'for example' about a reader", () => {
    const g = guardComment({ level: "argument", rationale: "A sceptical reader, for example a CFO reading this, would want the cost.", hint: "Name who carries the cost in this paragraph." }, draft);
    expect(g.ok).toBe(true);
  });
  it("keeps a rationale that states facts (regression from the first real run)", () => {
    const g = guardComment({ level: "argument", rationale: "APP 8 rests on accountability and reasonable steps, with consent as one exception among several.", hint: "Check APP 8 and section 16C, then narrow the clause starting 'which is what the…'." }, draft);
    expect(g.ok).toBe(true);
  });
  it("trims a hint over 45 words", () => {
    const long = "Support the claim in this paragraph. " + "Name the source and the date in this paragraph and check the claim against it. ".repeat(4);
    const g = guardComment({ level: "argument", rationale: "x", hint: long }, draft);
    expect(g.ok).toBe(true);
    expect(g.flags).toContain("trimmed");
  });
  it("finds quoted spans but not apostrophes", () => {
    expect(quotedSpans("Support the sentence starting 'Voluntary guidance…' in the draft")).toEqual(["Voluntary guidance"]);
  });
});

describe("example overlap", () => {
  it("rejects an example that reuses four words of the anchor", () => {
    expect(exampleOverlaps("Before: board behaviour across the ASX shifted.", "changed board behaviour across the ASX 200")).toBe(true);
    expect(exampleOverlaps("Before: The tram was late again. After: Trams ran nine minutes late.", "changed board behaviour across the ASX 200")).toBe(false);
  });
});
