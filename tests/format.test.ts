import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { toggleMark, setBlock, insertLink, insertNote, formatState } from "../client/src/editor/format.ts";

function st(doc: string, from: number, to = from) {
  const s = EditorState.create({ doc, selection: EditorSelection.range(from, to), extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}
const run = (s: EditorState, spec: any) => s.update(spec).state;

describe("inline marks", () => {
  it("bolds a selection and unbolds it again", () => {
    const s1 = run(st("make this bold now", 5, 14), toggleMark(st("make this bold now", 5, 14), "bold"));
    expect(s1.doc.toString()).toBe("make **this bold** now");
    const s2 = st(s1.doc.toString(), s1.selection.main.from, s1.selection.main.to);
    expect(formatState(s2).bold).toBe(true);
    expect(run(s2, toggleMark(s2, "bold")).doc.toString()).toBe("make this bold now");
  });
  it("italicises the word at the cursor", () => {
    const s = st("one two three", 5);
    expect(run(s, toggleMark(s, "italic")).doc.toString()).toBe("one *two* three");
  });
  it("keeps trailing spaces outside the markers", () => {
    const s = st("one two three", 4, 8);
    expect(run(s, toggleMark(s, "bold")).doc.toString()).toBe("one **two** three");
  });
  it("inserts an empty pair with the cursor between when there is no word", () => {
    const s = st("end. ", 5);
    const r = run(s, toggleMark(s, "bold"));
    expect(r.doc.toString()).toBe("end. ****");
    expect(r.selection.main.head).toBe(7);
  });
  it("does not mistake bold for italic", () => {
    const s = st("a **b** c", 4, 5);
    expect(formatState(s).italic).toBe(false);
    expect(formatState(s).bold).toBe(true);
  });
});

describe("line styles", () => {
  it("sets and clears headings", () => {
    const s = st("Title here\n\nBody.", 2);
    const h2 = run(s, setBlock(s, "h2"));
    expect(h2.doc.toString()).toBe("## Title here\n\nBody.");
    const back = st(h2.doc.toString(), 4);
    expect(run(back, setBlock(back, "h2")).doc.toString()).toBe("Title here\n\nBody.");
    expect(run(back, setBlock(back, "p")).doc.toString()).toBe("Title here\n\nBody.");
  });
  it("turns lines into a numbered list, skipping blank lines, and back", () => {
    const doc = "alpha\nbeta\n\ngamma";
    const s = st(doc, 0, doc.length);
    const n = run(s, setBlock(s, "number"));
    expect(n.doc.toString()).toBe("1. alpha\n2. beta\n\n3. gamma");
    const s2 = st(n.doc.toString(), 0, n.doc.length);
    expect(run(s2, setBlock(s2, "number")).doc.toString()).toBe("alpha\nbeta\n\ngamma");
  });
  it("switches a bulleted list to numbered", () => {
    const doc = "- a\n- b";
    const s = st(doc, 0, doc.length);
    expect(run(s, setBlock(s, "number")).doc.toString()).toBe("1. a\n2. b");
  });
  it("quotes a paragraph", () => {
    const s = st("Said it.", 0);
    expect(run(s, setBlock(s, "quote")).doc.toString()).toBe("> Said it.");
  });
});

describe("links and notes", () => {
  it("wraps the selection as a link and selects the URL placeholder", () => {
    const s = st("see the report", 8, 14);
    const r = run(s, insertLink(s));
    expect(r.doc.toString()).toBe("see the [report](https://)");
    expect(r.sliceDoc(r.selection.main.from, r.selection.main.to)).toBe("https://");
  });
  it("adds the first footnote with a notes block and moves the cursor to it", () => {
    const s = st("A claim.", 8);
    const r = run(s, insertNote(s, "FN", "ab12"));
    expect(r.doc.toString()).toBe("A claim.[^FN01-ab12]\n\n<!-- Footnotes -->\n\n[^FN01-ab12]: \n");
    expect(r.sliceDoc(r.selection.main.head - 14, r.selection.main.head)).toBe("[^FN01-ab12]: ");
  });
  it("numbers a new endnote by position and places its definition in order", () => {
    const doc = "One.[^EN01-aaaa] Two.\n\n<!-- Endnotes -->\n\n[^EN01-aaaa]: First.\n";
    const s = st(doc, doc.indexOf(" Two."));
    const r = run(s, insertNote(s, "EN", "bbbb"));
    expect(r.doc.toString()).toBe("One.[^EN01-aaaa][^EN02-bbbb] Two.\n\n<!-- Endnotes -->\n\n[^EN01-aaaa]: First.\n\n[^EN02-bbbb]: \n");
    expect(r.sliceDoc(r.selection.main.head - 14, r.selection.main.head)).toBe("[^EN02-bbbb]: ");
  });
  it("renumbers when a note is inserted above existing ones", () => {
    const doc = "Alpha.[^FN01-aaaa] Beta.[^FN02-bbbb]\n\n<!-- Footnotes -->\n\n[^FN01-aaaa]: A.\n\n[^FN02-bbbb]: B.\n";
    const s = st(doc, 0);
    const r = run(s, insertNote(s, "FN", "cccc"));
    expect(r.doc.toString()).toBe("[^FN01-cccc]Alpha.[^FN02-aaaa] Beta.[^FN03-bbbb]\n\n<!-- Footnotes -->\n\n[^FN01-cccc]: \n\n[^FN02-aaaa]: A.\n\n[^FN03-bbbb]: B.\n");
    expect(r.sliceDoc(r.selection.main.head - 14, r.selection.main.head)).toBe("[^FN01-cccc]: ");
  });
  it("puts footnotes before endnotes", () => {
    const doc = "Text.\n\n<!-- Endnotes -->\n\n[^EN01-aaaa]: E.\n";
    const s = st(doc, 5);
    const r = run(s, insertNote(s, "FN", "cccc"));
    expect(r.doc.toString()).toBe("Text.[^FN01-cccc]\n\n<!-- Footnotes -->\n\n[^FN01-cccc]: \n\n<!-- Endnotes -->\n\n[^EN01-aaaa]: E.\n");
  });
});
