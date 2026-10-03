import { describe, expect, it } from "vitest";
import { locate, reanchor } from "../server/anchor.ts";

const doc = "Alpha. The contract sets the terms. Beta.\n\nGamma: the contract sets the terms again. A curly “quote” and it’s fine.";

describe("locate", () => {
  it("finds an exact quote", () => {
    const l = locate(doc, "Beta.");
    expect(l?.method).toBe("exact");
    expect(doc.slice(l!.start, l!.end)).toBe("Beta.");
  });
  it("chooses the right duplicate by context", () => {
    const l = locate(doc, "the contract sets the terms", "Gamma: ", " again");
    expect(l!.start).toBe(doc.indexOf("the contract sets the terms again"));
  });
  it("matches straight quotes and collapsed whitespace against curly text", () => {
    const l = locate(doc, 'A curly "quote" and it\'s   fine.');
    expect(l?.method).toBe("normalised");
    expect(doc.slice(l!.start, l!.end)).toBe("A curly “quote” and it’s fine.");
  });
  it("matches a lightly paraphrased quote fuzzily", () => {
    const text = "Boards now ask who carries the cost of compliance when a model fails in production.";
    const l = locate(text, "Boards now ask who carries the cost of compliance when the model fails in production.");
    expect(l?.method).toBe("fuzzy");
    expect(l!.score).toBeGreaterThan(0.85);
  });
  it("drops an invented quote", () => {
    expect(locate(doc, "Procurement teams always read the contract twice before award.")).toBeNull();
  });
});

describe("reanchor", () => {
  it("follows the span after text is inserted before it", () => {
    const a = { exact: "Beta.", prefix: "the terms. ", suffix: "\n\nGamma", start: doc.indexOf("Beta.") };
    const edited = "New opening sentence. " + doc;
    const r = reanchor(edited, a)!;
    expect(edited.slice(r.start, r.end)).toBe("Beta.");
    expect(r.stale).toBe(false);
  });
  it("marks a rewritten span stale or lost", () => {
    const exact = "Boards now ask who carries the cost of compliance when a model fails.";
    const text = "Intro. " + exact + " Outro.";
    const edited = text.replace("who carries the cost of compliance", "who pays for compliance");
    const r = reanchor(edited, { exact, prefix: "Intro. ", suffix: " Outro.", start: 7 });
    expect(r === null || r.stale).toBe(true);
  });
});
