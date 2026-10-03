// Citations Release B: guarded parsing, formatting in AGLC4 and Chicago, preview safety.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sandbox } from "./helpers.ts";
import { renderStream, htmlToMd } from "../server/cite/format.ts";
import { checkParse, guardSource } from "../server/cite/parse.ts";
import { pageMeta } from "../server/cite/fetch.ts";

const sb = sandbox();
process.env.DRAFTROOM_HOME = sb.home;

const items: any = {
  hf: { id: "hf", type: "post-weblog", title: "Security Incident, July 2026", author: [{ literal: "Hugging Face" }], "container-title": "Hugging Face Blog", issued: { "date-parts": [[2026, 7, 21]] }, URL: "https://huggingface.co/blog/x" },
  rep: { id: "rep", type: "report", title: "The State of Widget Governance", author: [{ family: "Lee", given: "Lauren" }], publisher: "Example Institute", issued: { "date-parts": [[2023]] } },
};

describe("formatting", () => {
  it("AGLC4: full, ibid with pinpoint, and (n X)", () => {
    const r = renderStream("aglc4", items, [
      { key: "a", noteNumber: 1, refs: [{ id: "hf" }] },
      { key: "b", noteNumber: 2, refs: [{ id: "rep", locator: "14" }] },
      { key: "c", noteNumber: 3, refs: [{ id: "rep", locator: "15" }] },
      { key: "d", noteNumber: 4, refs: [{ id: "hf" }] },
    ]);
    expect(r.a).toBe("Hugging Face, ‘Security Incident, July 2026’, *Hugging Face Blog* (21 July 2026) <https://huggingface.co/blog/x>.");
    expect(r.c).toBe("Ibid 15.");
    expect(r.d).toBe("Hugging Face (n 1).");
  });
  it("Chicago 18: full then short form", () => {
    const r = renderStream("chicago18", items, [{ key: "a", noteNumber: 1, refs: [{ id: "rep", locator: "14" }] }, { key: "b", noteNumber: 2, refs: [{ id: "hf" }] }, { key: "c", noteNumber: 3, refs: [{ id: "rep", locator: "20" }] }]);
    expect(r.a).toMatch(/^Lauren Lee, \*The State of Widget Governance\* \(Example Institute, 2023\), 14\.$/);
    expect(r.c).toBe("Lee, *The State of Widget Governance*, 20.");
  });
  it("footnote and endnote streams do not refer across each other", () => {
    const fn = renderStream("aglc4", items, [{ key: "f1", noteNumber: 1, refs: [{ id: "hf" }] }]);
    const en = renderStream("aglc4", items, [{ key: "e1", noteNumber: 1, refs: [{ id: "hf" }] }]);
    expect(en.e1).toBe(fn.f1); // full form again in the other stream
  });
  it("converts citeproc HTML to markdown", () => {
    expect(htmlToMd("<i>Title</i> &#38; <b>bold</b> &lt;url&gt;")).toBe("*Title* & **bold** <url>");
  });
});

describe("parse guard", () => {
  const body = "Incidentally, I liked this. See: https://example.org/report";
  it("rejects segments that do not reproduce the note", () => {
    const r = checkParse("FN01-aaaa", body, [{ kind: "commentary", text: "Incidentally, I liked it." }, { kind: "citation", text: " See: https://example.org/report", sources: [{ type: "webpage", url: "https://example.org/report" }] }]);
    expect(r.ok).toBe(false);
  });
  it("keeps commentary exactly and drops invented fields", () => {
    const r = checkParse("FN01-aaaa", body, [
      { kind: "commentary", text: "Incidentally, I liked this. " },
      { kind: "citation", text: "See: https://example.org/report", sources: [{ type: "report", url: "https://example.org/report", title: "An Invented Title", year: 2025, authors: [{ family: "Nobody" }], prefix: "See" }] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.segments[0]).toEqual({ kind: "commentary", text: "Incidentally, I liked this. " });
    const s = r.segments[1].sources![0];
    expect(s.title).toBeUndefined();
    expect(s.year).toBeUndefined();
    expect(s.authors).toBeUndefined();
    expect(s.url).toBe("https://example.org/report");
    expect(r.warnings.join(" ")).toMatch(/left out title/);
  });
  it("keeps a month and day only when the note names them", () => {
    expect(guardSource({ type: "document", year: 2026, month: 9, day: 14 }, "OpenAI, 14 September 2026").source).toMatchObject({ year: 2026, month: 9, day: 14 });
    expect(guardSource({ type: "document", year: 2026, month: 9, day: 14 }, "OpenAI, 2026").source.month).toBeUndefined();
  });
});

describe("page metadata", () => {
  it("reads citation and Open Graph tags and strips only the site's own suffix", () => {
    const html = `<html><head><title>Incident Disclosure — July 2026 | Hugging Face</title><meta property="og:site_name" content="Hugging Face"><meta name="author" content="Jane Doe"><meta property="article:published_time" content="2026-07-21T10:00:00Z"></head></html>`;
    expect(pageMeta(html, "huggingface.co")).toMatchObject({ title: "Incident Disclosure — July 2026", site: "Hugging Face", authors: ["Jane Doe"], published: "2026-07-21" });
  });
});

describe("preview with a fake Claude", () => {
  it("formats in AGLC4, keeps commentary, flags loss, and never writes the draft", async () => {
    const runs = await import("../server/runs.ts");
    const { formatPreview, lostWords } = await import("../server/cite/preview.ts");
    const { loadProfile } = await import("../server/profile.ts");
    runs.initHome();
    const text = "A.[^FN01-aaaa] B.[^FN02-bbbb]\n\n<!-- Footnotes -->\n\n[^FN01-aaaa]: Lauren Lee, The State of Widget Governance (Example Institute, 2023) 14.\n\n[^FN02-bbbb]: I disagree with this one. Lauren Lee, The State of Widget Governance (Example Institute, 2023) 15.\n";
    fs.writeFileSync(sb.draft, text);
    const src = { type: "report", authors: [{ family: "Lee", given: "Lauren" }], title: "The State of Widget Governance", publisher: "Example Institute", year: 2023 };
    runs.engines.claude = async (i: any) => {
      expect(i.tools).toEqual([]);
      return { output: { notes: [
        { label: "FN01-aaaa", segments: [{ kind: "citation", text: "Lauren Lee, The State of Widget Governance (Example Institute, 2023) 14.", sources: [{ ...src, locator: "14" }] }] },
        { label: "FN02-bbbb", segments: [{ kind: "commentary", text: "I disagree with this one. " }, { kind: "citation", text: "Lauren Lee, The State of Widget Governance (Example Institute, 2023) 15.", sources: [{ ...src, locator: "15" }] }] },
      ] }, secs: 1, raw: "" };
    };
    const p = await formatPreview({ ...loadProfile(sb.profPath), library_dir: path.join(sb.root, "lib") }, sb.draft, text, "aglc4");
    const fn1 = p.entries.find((e) => e.label === "FN01-aaaa");
    const fn2 = p.entries.find((e) => e.label === "FN02-bbbb")!;
    expect(fn1?.after ?? "unchanged").toMatch(/Lauren Lee, \*The State of Widget Governance\* \(Example Institute, 2023\) 14\.|unchanged/);
    expect(fn2.after).toBe("I disagree with this one. Ibid 15.");
    expect(fs.readFileSync(sb.draft, "utf8")).toBe(text);
    expect(lostWords("OpenAI, 14 September 2026 quoted at ASPI Sydney Dialogue, panel", "OpenAI.")).toEqual(["openai".slice(0, 0) || "14", "september", "2026", "aspi", "sydney", "dialogue", "panel"].filter(Boolean));
  });
});
