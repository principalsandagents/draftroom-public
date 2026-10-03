// Opening and saving without typing must leave each fixture byte-identical.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { lineSeparatorFor } from "../client/src/editor/lineSep.ts";
import { blocks, bodyStart, outline, wordCount } from "../shared/doc.ts";

const dir = path.join(import.meta.dirname, "fixtures", "drafts");

describe("round trip through the editor state", () => {
  for (const f of fs.readdirSync(dir)) {
    it(f, () => {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const st = EditorState.create({ doc: src, extensions: [lineSeparatorFor(src)] });
      expect(st.sliceDoc()).toBe(src);
    });
  }
});

describe("document structure", () => {
  const text = fs.readFileSync(path.join(dir, "substack-post.md"), "utf8");
  it("starts the body after the marker", () => {
    expect(text.slice(bodyStart(text)).startsWith("## Why procurement matters")).toBe(true);
  });
  it("numbers paragraphs and knows their sections", () => {
    const ps = blocks(text).filter((b) => b.kind === "paragraph");
    expect(ps[0].section).toBe("Why procurement matters");
    expect(ps[0].index).toBe(1);
    expect(ps.find((p) => text.slice(p.start, p.end).startsWith("First, who"))!.section).toBe("Three questions for every tender");
  });
  it("treats a fenced block as one paragraph and ignores # inside it", () => {
    const t = fs.readFileSync(path.join(dir, "plain-article.md"), "utf8");
    expect(blocks(t).filter((b) => b.kind === "heading")).toHaveLength(1);
  });
  it("outlines and counts body words only", () => {
    expect(outline(text)).toContain("[p1] Most Australian agencies");
    expect(wordCount(text)).toBeLessThan(200);
  });
});
