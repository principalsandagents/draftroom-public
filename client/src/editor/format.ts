// Formatting commands for the toolbar and shortcuts. Each writes plain markdown and toggles:
// applying bold to bold text removes it. Commands are pure functions of the state so they can
// be tested without a browser.

import { EditorSelection, EditorState, type ChangeSpec, type TransactionSpec } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { renumberNotes } from "../../../shared/notes.ts";
import { minimalEdits } from "../../../shared/edits.ts";

export type Mark = "bold" | "italic" | "strike";
export type Block = "p" | "h1" | "h2" | "h3" | "bullet" | "number" | "quote";

const MARKS: Record<Mark, string> = { bold: "**", italic: "*", strike: "~~" };
const NODE: Record<Mark, string> = { bold: "StrongEmphasis", italic: "Emphasis", strike: "Strikethrough" };

const HEADING = /^(#{1,6})\s+/;
const BULLET = /^(\s*)[-*+]\s+/;
const NUMBER = /^(\s*)\d+[.)]\s+/;
const QUOTE = /^>\s?/;

// ---------------------------------------------------------------- inline marks

/** The enclosing emphasis node of this kind around [from, to], if any. */
function enclosing(state: EditorState, from: number, to: number, mark: Mark): { from: number; to: number } | null {
  let n: any = syntaxTree(state).resolveInner(from, 1);
  while (n) {
    if (n.name === NODE[mark] && n.from <= from && n.to >= to) return { from: n.from, to: n.to };
    n = n.parent;
  }
  return null;
}

/** Expand an empty selection to the word around the cursor. */
function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const w = state.wordAt(pos);
  return w && w.from < w.to ? { from: w.from, to: w.to } : null;
}

export function toggleMark(state: EditorState, mark: Mark): TransactionSpec {
  const m = MARKS[mark];
  return state.changeByRange((range) => {
    // Already marked: remove the markers around the enclosing node.
    const enc = enclosing(state, range.from, range.to, mark);
    if (enc) {
      const inner = state.sliceDoc(enc.from + m.length, enc.to - m.length);
      const changes: ChangeSpec = { from: enc.from, to: enc.to, insert: inner };
      const shift = (p: number) => Math.max(enc.from, Math.min(enc.from + inner.length, p - m.length));
      return { changes, range: EditorSelection.range(shift(range.anchor), shift(range.head)) };
    }
    // Markers typed inside the selection (**text** selected whole): strip them.
    const sel = state.sliceDoc(range.from, range.to);
    if (sel.length > 2 * m.length && sel.startsWith(m) && sel.endsWith(m) && !(mark === "italic" && sel.startsWith("**"))) {
      const inner = sel.slice(m.length, -m.length);
      return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
    }
    let { from, to } = range;
    if (from === to) {
      const w = wordAt(state, from);
      if (!w) {
        // Nothing to wrap: insert a pair and put the cursor between.
        return { changes: { from, insert: m + m }, range: EditorSelection.cursor(from + m.length) };
      }
      ({ from, to } = w);
    }
    // Keep surrounding spaces outside the markers: "**word** " is valid, "**word **" is not.
    while (from < to && /\s/.test(state.sliceDoc(from, from + 1))) from++;
    while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
    return {
      changes: [{ from, insert: m }, { from: to, insert: m }],
      range: EditorSelection.range(from + m.length, to + m.length),
    };
  });
}

// ---------------------------------------------------------------- line styles

function selectedLines(state: EditorState): Array<{ from: number; to: number; text: string; number: number }> {
  const seen = new Set<number>();
  const out: Array<{ from: number; to: number; text: string; number: number }> = [];
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      const l = state.doc.line(i);
      out.push({ from: l.from, to: l.to, text: l.text, number: i });
    }
  }
  return out;
}

/** Strip any heading, list or quote prefix from a line. */
function bare(text: string): { indent: string; rest: string } {
  let t = text.replace(QUOTE, "");
  t = t.replace(HEADING, "");
  const lead = /^\s*/.exec(t)![0];
  t = t.replace(BULLET, "").replace(NUMBER, "");
  return { indent: lead, rest: t.replace(/^\s+/, "") };
}

export function blockAt(state: EditorState, pos: number): Block {
  const t = state.doc.lineAt(pos).text;
  const h = HEADING.exec(t);
  if (h) return h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : "h3";
  if (QUOTE.test(t)) return "quote";
  if (BULLET.test(t)) return "bullet";
  if (NUMBER.test(t)) return "number";
  return "p";
}

export function setBlock(state: EditorState, block: Block): TransactionSpec {
  const lines = selectedLines(state).filter((l, i, all) => l.text.trim() || all.length === 1);
  const current = lines.length ? blockAt(state, lines[0].from) : "p";
  // Applying the style a line already has turns it back into normal text.
  const target: Block = current === block && block !== "p" ? "p" : block;
  let n = 0;
  const changes: ChangeSpec[] = lines.map((l) => {
    const { indent, rest } = bare(l.text);
    let prefix = "";
    if (target === "h1") prefix = "# ";
    else if (target === "h2") prefix = "## ";
    else if (target === "h3") prefix = "### ";
    else if (target === "quote") prefix = "> ";
    else if (target === "bullet") prefix = `${indent}- `;
    else if (target === "number") prefix = `${indent}${++n}. `;
    return { from: l.from, to: l.to, insert: prefix + rest };
  });
  const tr = state.update({ changes });
  // Put the cursor at the end of the text on the last line touched.
  const lastLine = tr.state.doc.line(lines.length ? lines[lines.length - 1].number : state.doc.lineAt(state.selection.main.head).number);
  return { changes, selection: EditorSelection.cursor(lastLine.to) };
}

// ---------------------------------------------------------------- links and notes

export function insertLink(state: EditorState): TransactionSpec {
  const r = state.selection.main;
  let { from, to } = r;
  if (from === to) {
    const w = wordAt(state, from);
    if (w) ({ from, to } = w);
  }
  const text = state.sliceDoc(from, to) || "link text";
  const insert = `[${text}](https://)`;
  const urlStart = from + text.length + 3;
  return { changes: { from, to, insert }, selection: EditorSelection.range(urlStart, urlStart + "https://".length) };
}

function randomId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/**
 * Insert a note reference at the cursor and a definition, then renumber that kind in reading
 * order (so a note added above others takes the lower number and the rest shift). Applied as
 * minimal edits; the cursor moves to the new definition.
 */
export function insertNote(state: EditorState, kind: "FN" | "EN", id = randomId()): TransactionSpec {
  const doc = state.sliceDoc();
  const at = state.selection.main.head;
  const temp = `${kind}999-${id}`;
  // Put the reference in, add a definition at the end, then let renumbering place and number it.
  const withRef = doc.slice(0, at) + `[^${temp}]` + doc.slice(at);
  const withDef = `${withRef.replace(/\s+$/, "")}\n\n[^${temp}]: \n`;
  const r = renumberNotes(withDef);
  const finalText = r.text;
  const label = r.mapping[temp] ?? temp;
  const head = `[^${label}]: `;
  const defAt = finalText.indexOf(head);
  const changes = minimalEdits(doc, finalText);
  return { changes, selection: EditorSelection.cursor(defAt + head.length), scrollIntoView: true };
}

// ---------------------------------------------------------------- state for the toolbar

export interface FormatState {
  block: Block;
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

export function formatState(state: EditorState): FormatState {
  const r = state.selection.main;
  return {
    block: blockAt(state, r.head),
    bold: !!enclosing(state, r.from, r.to, "bold"),
    italic: !!enclosing(state, r.from, r.to, "italic"),
    strike: !!enclosing(state, r.from, r.to, "strike"),
  };
}
