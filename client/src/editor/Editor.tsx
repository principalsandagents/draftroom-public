// CodeMirror 6 editor with live preview and comment marks. The only text that enters the
// document is what the writer types or pastes.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine, dropCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentUnit } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { livePreview, bodyStartPos, togglePrep, isPrepOpen } from "./livePreview.ts";
import { lineSeparatorFor } from "./lineSep.ts";
import { toggleMark, setBlock, insertLink, insertNote, formatState, type FormatState } from "./format.ts";
import { minimalEdits } from "../../../shared/edits.ts";
import type { FormatCommand } from "./Toolbar.tsx";
import { commentMarks, markPosition, setActive, setMarks, locallyStale, type MarkComment } from "./marks.ts";

export interface EditorHandle {
  getText(): string;
  getSelection(): { from: number; to: number };
  setText(text: string): void;
  setMarks(m: MarkComment[]): void;
  setActive(id: string | null, scroll?: boolean): void;
  positionOf(id: string): { from: number; to: number } | null;
  locallyStale(): Set<string>;
  togglePrep(): void;
  focus(): void;
  format(c: FormatCommand): void;
  applyText(next: string): void; // replace the document with minimal edits (one undo step)
  insertImage(rel: string, alt: string, at?: number): void;
}

interface Props {
  initial: string;
  onChange: (text: string) => void;
  onSelectComment: (id: string) => void;
  onCursor?: (pos: number) => void;
  onFormat?: (s: FormatState) => void;
  onImageFile?: (f: File, at: number) => void;
}

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--muted)" },
  { tag: tags.monospace, fontFamily: "var(--mono)" },
  { tag: tags.processingInstruction, color: "var(--muted)" },
  { tag: tags.comment, color: "var(--muted)" },
  { tag: tags.meta, color: "var(--muted)" },
]);

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ initial, onChange, onSelectComment, onCursor, onFormat, onImageFile }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef<any>({ onChange, onSelectComment, onCursor, onFormat, onImageFile });
  cb.current = { onChange, onSelectComment, onCursor, onFormat, onImageFile } as any;
  const apply = (v: EditorView, c: FormatCommand) => {
    const s = v.state;
    const spec = "mark" in c ? toggleMark(s, c.mark) : "block" in c ? setBlock(s, c.block) : "link" in c ? insertLink(s) : insertNote(s, c.note);
    v.dispatch(s.update({ ...spec, userEvent: "input.format", scrollIntoView: true }));
    v.focus();
    return true;
  };

  const makeState = (doc: string) => {
    const st = EditorState.create({
      doc,
      extensions: [
        lineSeparatorFor(doc),
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.domEventHandlers({
          paste: (e, v) => {
            const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
            if (!f || !cb.current.onImageFile) return false;
            e.preventDefault();
            cb.current.onImageFile(f, v.state.selection.main.head);
            return true;
          },
          drop: (e, v) => {
            const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith("image/"));
            if (!f || !cb.current.onImageFile) return false;
            e.preventDefault();
            const at = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            cb.current.onImageFile(f, at);
            return true;
          },
        }),
        highlightActiveLine(),
        indentUnit.of("    "),
        keymap.of([
          { key: "Mod-b", run: (v) => apply(v, { mark: "bold" }) },
          { key: "Mod-i", run: (v) => apply(v, { mark: "italic" }) },
          { key: "Mod-Shift-x", run: (v) => apply(v, { mark: "strike" }) },
          { key: "Mod-k", run: (v) => apply(v, { link: true }) },
          { key: "Mod-Alt-0", run: (v) => apply(v, { block: "p" }) },
          { key: "Mod-Alt-1", run: (v) => apply(v, { block: "h1" }) },
          { key: "Mod-Alt-2", run: (v) => apply(v, { block: "h2" }) },
          { key: "Mod-Alt-3", run: (v) => apply(v, { block: "h3" }) },
          { key: "Mod-Shift-8", run: (v) => apply(v, { block: "bullet" }) },
          { key: "Mod-Shift-7", run: (v) => apply(v, { block: "number" }) },
          { key: "Mod-Shift-9", run: (v) => apply(v, { block: "quote" }) },
          { key: "Mod-Alt-f", run: (v) => apply(v, { note: "FN" }) },
          { key: "Mod-Alt-e", run: (v) => apply(v, { note: "EN" }) },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "sentences" }),
        livePreview,
        commentMarks((id) => cb.current.onSelectComment(id)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.sliceDoc());
          if (u.selectionSet) cb.current.onCursor?.(u.state.selection.main.head);
          if (u.selectionSet || u.docChanged) cb.current.onFormat?.(formatState(u.state));
        }),
      ],
    });
    const start = bodyStartPos(st);
    return st.update({ selection: EditorSelection.cursor(start) }).state;
  };

  useEffect(() => {
    view.current = new EditorView({ state: makeState(initial), parent: host.current! });
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    getText: () => view.current!.state.sliceDoc(),
    getSelection: () => {
      const s = view.current!.state.selection.main;
      return { from: s.from, to: s.to };
    },
    setText: (text) => view.current!.setState(makeState(text)),
    setMarks: (m) => view.current!.dispatch({ effects: setMarks.of(m) }),
    setActive: (id, scroll = true) => {
      const v = view.current!;
      const effects: any[] = [setActive.of(id)];
      if (id && scroll) {
        const p = markPosition(v, id);
        if (p) effects.push(EditorView.scrollIntoView(p.from, { y: "center" }));
      }
      v.dispatch({ effects });
    },
    positionOf: (id) => markPosition(view.current!, id),
    locallyStale: () => locallyStale(view.current!),
    togglePrep: () => view.current!.dispatch({ effects: togglePrep.of(!isPrepOpen(view.current!.state)) }),
    focus: () => view.current!.focus(),
    format: (c) => {
      apply(view.current!, c);
    },
    insertImage: (rel, alt, at) => {
      const v = view.current!;
      // On its own line, after the line the cursor is on, with blank lines around it.
      const line = v.state.doc.lineAt(at ?? v.state.selection.main.head);
      const before = line.text.trim() ? "\n\n" : "";
      const next = v.state.doc.lines > line.number ? v.state.doc.line(line.number + 1).text : "";
      const after = next.trim() ? "\n\n" : "\n";
      const md = `![${alt}](${rel})`;
      const insert = `${before}${md}${after}`;
      const altFrom = line.to + before.length + 2;
      v.dispatch({ changes: { from: line.to, insert }, selection: { anchor: altFrom, head: altFrom + alt.length }, userEvent: "input.image", scrollIntoView: true });
      v.focus();
    },
    applyText: (next) => {
      const v = view.current!;
      const changes = minimalEdits(v.state.sliceDoc(), next);
      if (changes.length) v.dispatch({ changes, userEvent: "input.citations", scrollIntoView: false });
    },
  }));

  return <div className="editor-host" ref={host} />;
});
