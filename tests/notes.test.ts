import { describe, expect, it } from "vitest";
import { parseNotes, renumberNotes, convertNotes, replaceDefinitionBodies } from "../shared/notes.ts";
import { minimalEdits, applyEdits } from "../shared/edits.ts";

const doc = [
  "Intro.[^FN02-bbbb] Middle.[^FN01-aaaa] Again.[^FN02-bbbb]",
  "",
  "End.[^EN01-eeee]",
  "",
  "<!-- Footnotes -->",
  "",
  "[^FN01-aaaa]: First defined.",
  "",
  "[^FN02-bbbb]: Second defined, with a nested ref.[^FN03-cccc]",
  "",
  "[^FN03-cccc]: Only referenced inside a note.",
  "",
  "[^FN09-zzzz]: Never referenced.",
  "",
  "<!-- Endnotes -->",
  "",
  "[^EN01-eeee]: An endnote.",
  "    Second paragraph of it.",
  "",
].join("\n");

describe("notes", () => {
  it("parses references and multi-paragraph definitions", () => {
    const p = parseNotes(doc);
    expect(p.refs.filter((r) => !r.inDefinition).map((r) => r.label)).toEqual(["FN02-bbbb", "FN01-aaaa", "FN02-bbbb", "EN01-eeee"]);
    expect(p.refs.find((r) => r.label === "FN03-cccc")!.inDefinition).toBe(true);
    expect(p.defs.find((d) => d.label === "EN01-eeee")!.body).toBe("An endnote.\nSecond paragraph of it.");
  });
  it("renumbers in reading order, keeps suffixes, nested notes after their parent, unreferenced last", () => {
    const r = renumberNotes(doc);
    expect(r.mapping).toMatchObject({ "FN02-bbbb": "FN01-bbbb", "FN03-cccc": "FN02-cccc", "FN01-aaaa": "FN03-aaaa", "FN09-zzzz": "FN04-zzzz" });
    expect(r.unreferenced).toEqual(["FN09-zzzz"]);
    expect(r.text).toContain("Intro.[^FN01-bbbb] Middle.[^FN03-aaaa] Again.[^FN01-bbbb]");
    const defs = parseNotes(r.text).defs.map((d) => d.label);
    expect(defs).toEqual(["FN01-bbbb", "FN02-cccc", "FN03-aaaa", "FN04-zzzz", "EN01-eeee"]);
    expect(r.text).toContain("[^EN01-eeee]: An endnote.\n    Second paragraph of it.");
  });
  it("flags nested and repeated notes", () => {
    const r = renumberNotes(doc);
    expect(r.nested).toEqual(["FN03-cccc"]);
    expect(r.repeated).toEqual(["FN02-bbbb"]);
  });
  it("never relabels inside fenced code", () => {
    const t = "A.[^FN02-bbbb] B.[^FN01-aaaa]\n\n```\n[^FN01-aaaa] in code\n```\n\n[^FN01-aaaa]: a\n\n[^FN02-bbbb]: b\n";
    expect(renumberNotes(t).text).toContain("```\n[^FN01-aaaa] in code\n```");
  });
  it("refuses a renumber that would change a label's length inside a grid table", () => {
    const t = "+------+\n| x[^n1] |\n+------+\n\nA.[^n1]\n\n[^n1]: a\n";
    expect(renumberNotes(t, { adoptPlain: true, convert: { n1: "FN" } }).error).toMatch(/grid table/);
  });
  it("leaves an already ordered document byte-identical", () => {
    const once = renumberNotes(doc).text;
    const twice = renumberNotes(once);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
  });
  it("converts footnotes to endnotes and back without loss", () => {
    const base = renumberNotes(doc).text;
    const toEn = convertNotes(base, "FN", "EN");
    expect(parseNotes(toEn.text).defs.every((d) => d.label.startsWith("EN"))).toBe(true);
    expect(toEn.text).not.toContain("<!-- Footnotes -->");
    const back = convertNotes(toEn.text, "EN", "FN", Object.values(toEn.mapping).filter((l) => !l.endsWith("eeee")));
    expect(back.text).toBe(base);
  });
  it("adopts plain labels when asked, except inside grid tables", () => {
    const plain = "A.[^1] B.[^note]\n\n+------+\n| x[^g] |\n+------+\n\n[^1]: One.\n\n[^note]: Two.\n\n[^g]: In a grid.\n";
    const r = renumberNotes(plain, { adoptPlain: true });
    expect(r.adopted).toBe(2);
    expect(r.text).toMatch(/A\.\[\^FN01-[a-z0-9]{4}\] B\.\[\^FN02-[a-z0-9]{4}\]/);
    expect(r.text).toContain("| x[^g] |");
  });
  it("replaces definition bodies only", () => {
    const out = replaceDefinitionBodies(doc, { "FN01-aaaa": "New text." });
    expect(out).toContain("[^FN01-aaaa]: New text.");
    expect(out.replace("New text.", "First defined.")).toBe(doc);
  });
  it("minimal edits reproduce the target and touch little", () => {
    const after = renumberNotes(doc).text;
    const e = minimalEdits(doc, after);
    expect(applyEdits(doc, e)).toBe(after);
    expect(e.reduce((n, x) => n + (x.to - x.from), 0)).toBeLessThan(doc.length / 2);
  });
});

describe("note jumps", () => {
  it("finds a note's first reference in the text and its definition", async () => {
    const { notePosition } = await import("../client/src/editor/livePreview.ts");
    const t = "Body text.[^FN01-aaaa] More.[^FN01-aaaa]\n\n<!-- Footnotes -->\n\n[^FN01-aaaa]: The note.\n";
    expect(notePosition(t, "FN01-aaaa", "ref")).toEqual({ from: 10, to: 22 });
    const def = notePosition(t, "FN01-aaaa", "def")!;
    expect(t.slice(def.from, def.to + 1)).toBe("[^FN01-aaaa]:");
  });
});
