// Runs a stand-in tell-lint with the same interface. DRAFTROOM_REAL_LINT=<path> runs your own
// script instead, so a change in its output format fails here.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintFindings, runTellLint, readabilityFindings, lintCommentTexts, relocateHits } from "../server/engines/lint.ts";

const prof = {
  python: "python3",
  tell_lint: process.env.DRAFTROOM_REAL_LINT ?? path.join(import.meta.dirname, "fixtures", "lint", "tell-lint-stub.py"),
};

describe("tell-lint integration", () => {
  it("finds a stock connector and anchors it", () => {
    const text = "First line is fine.\n\nMoreover, the board should act.";
    const hits = relocateHits(prof.python, prof.tell_lint, text, runTellLint(prof.python, prof.tell_lint, text));
    expect(hits.some((h) => h.rule === "stock-connector" && h.line === 3)).toBe(true);
    const f = lintFindings(text, hits);
    const m = f.find((x) => x.title === "Stock phrase")!;
    expect(text.slice(m.start, m.end)).toContain("Moreover");
  });
  it("reports warnings when there is no fail", () => {
    const hits = runTellLint(prof.python, prof.tell_lint, "A robust approach, generally speaking.");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.tier === "warn")).toBe(true);
  });
  it("flags comment text that trips a fail", () => {
    const s = lintCommentTexts(prof.python, prof.tell_lint, ["Support the claim in this paragraph.", "Moreover, cut the paragraph."]);
    expect([...s]).toEqual([1]);
  });
});

describe("readability", () => {
  it("flags sentences over 35 words", () => {
    const long = "This sentence " + "keeps going and going ".repeat(9) + "until it ends.";
    const f = readabilityFindings(`Short one. ${long} Another.`);
    expect(f.some((x) => x.title.startsWith("Long sentence"))).toBe(true);
  });
});
