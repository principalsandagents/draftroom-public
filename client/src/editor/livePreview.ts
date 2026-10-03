// Obsidian-style live preview for CodeMirror 6. The document is the markdown, byte for byte;
// these are decorations only. Syntax is hidden on lines the cursor is not on.

import { syntaxTree } from "@codemirror/language";
import { EditorState, Range, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";

const hide = Decoration.replace({});

function activeLines(state: EditorState): Set<number> {
  const s = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) s.add(i);
  }
  return s;
}

/** Inline syntax: hide marks off the active line, style headings, links, footnotes, placeholders. */
function inlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  const bodyFrom = bodyStartPos(state);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        if (node.from < bodyFrom) return;
        const line = state.doc.lineAt(node.from);
        const onActive = active.has(line.number);
        const name = node.name;
        const h = /^ATXHeading(\d)$/.exec(name);
        if (h) {
          decos.push(Decoration.line({ class: `cm-h cm-h${h[1]}` }).range(line.from));
          return;
        }
        if (name === "Emphasis") decos.push(Decoration.mark({ class: "cm-em" }).range(node.from, node.to));
        if (name === "StrongEmphasis") decos.push(Decoration.mark({ class: "cm-strong" }).range(node.from, node.to));
        if (name === "Strikethrough") decos.push(Decoration.mark({ class: "cm-strike" }).range(node.from, node.to));
        if (name === "InlineCode") decos.push(Decoration.mark({ class: "cm-icode" }).range(node.from, node.to));
        // Footnote syntax ([^FN01-k3x9] and its [^…]: definition) parses as a link: leave it to
        // the footnote decorations below.
        if ((name === "Link" || name === "LinkReference") && state.doc.sliceString(node.from, node.from + 2) === "[^") return false;
        if (name === "Link") decos.push(Decoration.mark({ class: "cm-link" }).range(node.from, node.to));
        if (name === "Blockquote") {
          for (let p = node.from; p <= node.to; ) {
            const l = state.doc.lineAt(p);
            decos.push(Decoration.line({ class: "cm-quote" }).range(l.from));
            p = l.to + 1;
          }
        }
        if (onActive) return;
        if (name === "HeaderMark") {
          const end = Math.min(node.to + 1, line.to);
          decos.push(hide.range(node.from, end));
        } else if (name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark") {
          if (node.to > node.from && state.doc.sliceString(node.from, node.to) !== "```") decos.push(hide.range(node.from, node.to));
        } else if (name === "LinkMark") {
          decos.push(hide.range(node.from, node.to));
        } else if (name === "URL" && node.node.parent?.name === "Link") {
          decos.push(hide.range(node.from, node.to));
        } else if (name === "QuoteMark") {
          const end = state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          decos.push(hide.range(node.from, end));
        } else if (name === "ListMark") {
          decos.push(Decoration.mark({ class: "cm-listmark" }).range(node.from, node.to));
        }
      },
    });

    // Footnote markers and placeholders by regex (not in the markdown grammar).
    const text = state.doc.sliceString(from, to);
    const fn = /\[\^([^\]\s]+)\](?!:)/g;
    let m: RegExpExecArray | null;
    while ((m = fn.exec(text))) {
      const a = from + m.index;
      if (a < bodyFrom) continue;
      const onActive = active.has(state.doc.lineAt(a).number);
      if (onActive) decos.push(Decoration.mark({ class: "cm-fnref" }).range(a, a + m[0].length));
      else decos.push(Decoration.replace({ widget: new FootnoteRef(m[1], footnoteText(state, m[1])) }).range(a, a + m[0].length));
    }
    const ph = /⟦[^⟧\n]*⟧/g;
    while ((m = ph.exec(text))) decos.push(Decoration.mark({ class: "cm-placeholder" }).range(from + m.index, from + m.index + m[0].length));
    const fdef = /^\[\^([^\]\s]+)\]:/gm;
    while ((m = fdef.exec(text))) {
      const a = from + m.index;
      decos.push(Decoration.line({ class: "cm-fndef" }).range(state.doc.lineAt(a).from));
      if (!active.has(state.doc.lineAt(a).number)) decos.push(Decoration.replace({ widget: new NoteBack(m[1]) }).range(a, a + m[0].length));
    }
  }
  return Decoration.set(decos, true);
}

function footnoteText(state: EditorState, id: string): string {
  const doc = state.doc.toString();
  const re = new RegExp(`^\\[\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:\\s*(.*)$`, "m");
  return re.exec(doc)?.[1] ?? "(no footnote definition)";
}

// ---------------------------------------------------------------- note jumps

const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setFlash)) v = e.value ? Decoration.set([Decoration.mark({ class: "cm-noteflash" }).range(e.value.from, e.value.to)]) : Decoration.none;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First reference to a note in the text (not its definition), or its definition. */
export function notePosition(doc: string, label: string, which: "ref" | "def"): { from: number; to: number } | null {
  const tag = `[^${label}]`;
  if (which === "def") {
    const m = new RegExp(`^${escapeRe(tag)}:`, "m").exec(doc);
    return m ? { from: m.index, to: m.index + tag.length } : null;
  }
  let i = doc.indexOf(tag);
  while (i >= 0) {
    const atLineStart = i === 0 || doc[i - 1] === "\n";
    if (!(atLineStart && doc[i + tag.length] === ":")) return { from: i, to: i + tag.length };
    i = doc.indexOf(tag, i + 1);
  }
  return null;
}

function jumpToNote(view: EditorView, label: string, which: "ref" | "def") {
  const p = notePosition(view.state.sliceDoc(), label, which);
  if (!p) return;
  // Land just after a body reference (so the superscript stays rendered), or at the start of the note text.
  const head = which === "ref" ? p.to : Math.min(view.state.doc.length, p.to + 2);
  view.dispatch({ selection: { anchor: head }, effects: [EditorView.scrollIntoView(head, { y: "center" }), setFlash.of(p)] });
  view.focus();
  setTimeout(() => view.dispatch({ effects: setFlash.of(null) }), 1400);
}

function noteNumber(label: string): string {
  const m = /^(FN|EN)0*(\d+)-/.exec(label);
  return m ? `${m[1] === "EN" ? "e" : ""}${m[2]}` : label;
}

/** A note's label in the notes section: its number with a back arrow; click to go to the text. */
class NoteBack extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(o: NoteBack) {
    return o.label === this.label;
  }
  toDOM(view: EditorView) {
    const s = document.createElement("span");
    s.className = "cm-noteback";
    s.textContent = `${noteNumber(this.label)} ↩`;
    s.title = `${this.label}: click to go to where this note is referenced`;
    s.onmousedown = (e) => {
      e.preventDefault();
      jumpToNote(view, this.label, "ref");
    };
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

class FootnoteRef extends WidgetType {
  constructor(readonly id: string, readonly title: string) {
    super();
  }
  eq(o: FootnoteRef) {
    return o.id === this.id && o.title === this.title;
  }
  toDOM(view: EditorView) {
    const s = document.createElement("sup");
    s.className = "cm-fn";
    s.onmousedown = (e) => {
      e.preventDefault();
      jumpToNote(view, this.id, "def");
    };
    // FN01-k3x9 shows as 1, EN07-p2qa as e7; the full label is in the tooltip.
    const m = /^(FN|EN)0*(\d+)-/.exec(this.id);
    s.textContent = m ? `${m[1] === "EN" ? "e" : ""}${m[2]}` : this.id;
    s.title = `${this.id}: ${this.title} (click to go to the note)`;
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

export const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = inlineDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = inlineDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------- block widgets (state field)

export const togglePrep = StateEffect.define<boolean>();

const prepOpen = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(togglePrep)) return e.value;
    return v;
  },
});

/** Offset where the body starts: after a `<!-- body -->` line, else after frontmatter. */
export function bodyStartPos(state: EditorState): number {
  const doc = state.doc.toString();
  const marker = doc.lastIndexOf("<!-- body -->");
  if (marker >= 0) {
    const nl = doc.indexOf("\n", marker);
    return nl < 0 ? doc.length : nl + 1;
  }
  if (doc.startsWith("---\n")) {
    const close = doc.indexOf("\n---", 4);
    if (close >= 0) {
      const nl = doc.indexOf("\n", close + 4);
      return nl < 0 ? doc.length : nl + 1;
    }
  }
  return 0;
}

class PrepWidget extends WidgetType {
  constructor(readonly lines: number, readonly hasPrep: boolean) {
    super();
  }
  eq(o: PrepWidget) {
    return o.lines === this.lines && o.hasPrep === this.hasPrep;
  }
  toDOM(view: EditorView) {
    const d = document.createElement("div");
    d.className = "cm-prepfold";
    d.textContent = `${this.hasPrep ? "Frontmatter and prep" : "Frontmatter"} (${this.lines} lines) · show`;
    d.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ effects: togglePrep.of(true) });
    };
    return d;
  }
  ignoreEvent() {
    return false;
  }
}

class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.src === this.src;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-tablewrap";
    const t = document.createElement("table");
    const rows = this.src.split("\n").filter((r) => r.trim());
    rows.forEach((r, i) => {
      if (i === 1 && /^\s*\|?\s*:?-{2,}/.test(r)) return;
      const tr = document.createElement("tr");
      const cells = r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
      for (const c of cells) {
        const td = document.createElement(i === 0 ? "th" : "td");
        td.textContent = c.trim().replace(/\*\*/g, "").replace(/`/g, "");
        tr.appendChild(td);
      }
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    return wrap;
  }
}

const gridCache = new Map<string, string>();

class GridWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(o: GridWidget) {
    return o.src === this.src;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-tablewrap cm-grid";
    const cached = gridCache.get(this.src);
    if (cached !== undefined) d.innerHTML = cached;
    else {
      d.textContent = "Rendering table…";
      fetch("/api/render-grid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ md: this.src }), credentials: "same-origin" })
        .then((r) => r.json())
        .then((j) => {
          gridCache.set(this.src, j.html ?? "");
          d.innerHTML = j.html ?? "";
        })
        .catch(() => (d.textContent = "Table preview unavailable"));
    }
    return d;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly id: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-imgwrap";
    const img = document.createElement("img");
    img.src = /^https?:/.test(this.src) ? "" : `/api/asset?rel=${encodeURIComponent(this.src)}`;
    img.alt = this.alt;
    img.onerror = () => { img.remove(); d.prepend(`Image not found: ${this.src}`); };
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = [this.alt, this.id].filter(Boolean).join(" · ");
    d.append(img, cap);
    return d;
  }
}

function blockDecorations(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const sel = state.selection.main;
  const bodyFrom = bodyStartPos(state);
  const touches = (from: number, to: number) => state.selection.ranges.some((r) => r.to >= from && r.from <= to);

  if (bodyFrom > 0 && !state.field(prepOpen) && !touches(0, bodyFrom - 1)) {
    const end = Math.max(0, bodyFrom - 1);
    const lines = state.doc.lineAt(end).number;
    const hasPrep = state.doc.sliceString(0, bodyFrom).includes("## Prep");
    b.add(0, end, Decoration.replace({ widget: new PrepWidget(lines, hasPrep), block: true }));
  }
  // Lines that are only an image: show the picture off the active line.
  const doc = state.doc;
  const imgLine = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/;
  const imageRanges: Array<[number, number, Decoration]> = [];
  for (let i = doc.lineAt(bodyFrom).number; i <= doc.lines; i++) {
    const l = doc.line(i);
    if (l.length > 600 || !l.text.includes("![")) continue;
    const m = imgLine.exec(l.text);
    if (!m || touches(l.from, l.to)) continue;
    imageRanges.push([l.from, l.to, Decoration.replace({ widget: new ImageWidget(m[2], m[1], m[3] ?? ""), block: true })]);
  }
  const tables: Array<[number, number, Decoration]> = [];
  // Grid tables: a border line, then lines starting with | or +.
  for (let i = doc.lineAt(bodyFrom).number; i <= doc.lines; i++) {
    const first = doc.line(i);
    if (!/^\+[-=:+]+\+\s*$/.test(first.text)) continue;
    let j = i;
    while (j + 1 <= doc.lines && /^[|+]/.test(doc.line(j + 1).text)) j++;
    const last = doc.line(j);
    if (j > i && !touches(first.from, last.to)) tables.push([first.from, last.to, Decoration.replace({ widget: new GridWidget(doc.sliceString(first.from, last.to)), block: true })]);
    i = j;
  }
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table" || node.from < bodyFrom) return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      if (touches(from, to) || sel.from === from) return false;
      tables.push([from, to, Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to)), block: true })]);
      return false;
    },
  });
  for (const [f, t, d] of [...imageRanges, ...tables].sort((x, y) => x[0] - y[0])) {
    if (f >= bodyFrom || bodyFrom === 0) b.add(f, t, d);
  }
  return b.finish();
}

const blocks = StateField.define<DecorationSet>({
  create: (s) => blockDecorations(s),
  update: (v, tr) =>
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(togglePrep)) || syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? blockDecorations(tr.state)
      : v,
  provide: (f) => EditorView.decorations.from(f),
});

export const livePreview = [prepOpen, blocks, inlinePreview, flashField];

export function isPrepOpen(state: EditorState): boolean {
  return state.field(prepOpen, false) ?? false;
}
