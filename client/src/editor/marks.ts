// Comment decorations: wavy underline per perspective colour for sentence-level comments,
// a left bar for paragraph-and-above comments, gutter dots, and a flash on the active one.
// Positions are mapped through every edit; an edit inside a span marks it locally stale.

import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, GutterMarker, gutter, hoverTooltip } from "@codemirror/view";

export interface MarkComment {
  id: string;
  from: number;
  to: number;
  colour: string;
  block: boolean; // paragraph, structure or argument level: draw a bar, not an underline
  dashed?: boolean; // Jev signals
  title: string;
  hint: string;
  perspective: string;
  stale: boolean;
}

export const setMarks = StateEffect.define<MarkComment[]>();
export const setActive = StateEffect.define<string | null>();

interface MarksState {
  items: MarkComment[];
  active: string | null;
}

export const marksField = StateField.define<MarksState>({
  create: () => ({ items: [], active: null }),
  update(v, tr) {
    let items = v.items;
    let active = v.active;
    if (tr.docChanged) {
      items = items.map((m) => {
        const touched = tr.changes.touchesRange(m.from, m.to) !== false;
        const from = tr.changes.mapPos(m.from, 1);
        const to = Math.max(from, tr.changes.mapPos(m.to, -1));
        return { ...m, from, to, stale: m.stale || touched };
      });
    }
    for (const e of tr.effects) {
      if (e.is(setMarks)) items = e.value;
      if (e.is(setActive)) active = e.value;
    }
    return items === v.items && active === v.active ? v : { items, active };
  },
});

function decorations(state: MarksState, doc: EditorView["state"]["doc"]): DecorationSet {
  const ranges: Array<{ from: number; to: number; d: Decoration }> = [];
  for (const m of state.items) {
    if (m.to <= m.from || m.to > doc.length) continue;
    const isActive = m.id === state.active;
    if (m.block) {
      const a = doc.lineAt(m.from).number;
      const b = doc.lineAt(m.to).number;
      for (let i = a; i <= b; i++) {
        ranges.push({
          from: doc.line(i).from, to: doc.line(i).from,
          d: Decoration.line({ attributes: { class: `cm-cbar${m.dashed ? " cm-cbar-dashed" : ""}${isActive ? " cm-cbar-active" : ""}`, style: `--c:${m.colour}` } }),
        });
      }
    } else {
      ranges.push({
        from: m.from, to: m.to,
        d: Decoration.mark({
          class: `cm-cmark${isActive ? " cm-cactive" : ""}${m.stale ? " cm-cstale" : ""}`,
          attributes: { style: `--c:${m.colour}`, "data-cid": m.id },
        }),
      });
    }
  }
  return Decoration.set(ranges.map((r) => r.d.range(r.from, r.to)), true);
}

const marksDecorations = EditorView.decorations.compute([marksField, "doc"], (s) => decorations(s.field(marksField), s.doc));

class DotsMarker extends GutterMarker {
  constructor(readonly colours: string[]) {
    super();
  }
  eq(o: DotsMarker) {
    return o.colours.join() === this.colours.join();
  }
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-dots";
    for (const c of this.colours.slice(0, 4)) {
      const s = document.createElement("span");
      s.style.background = c;
      d.appendChild(s);
    }
    return d;
  }
}

function gutterMarkers(view: EditorView): RangeSet<GutterMarker> {
  const st = view.state.field(marksField);
  const doc = view.state.doc;
  const byLine = new Map<number, Set<string>>();
  for (const m of st.items) {
    if (m.from > doc.length) continue;
    const l = doc.lineAt(m.from).from;
    if (!byLine.has(l)) byLine.set(l, new Set());
    byLine.get(l)!.add(m.colour);
  }
  const b = new RangeSetBuilder<GutterMarker>();
  for (const l of [...byLine.keys()].sort((a, c) => a - c)) b.add(l, l, new DotsMarker([...byLine.get(l)!]));
  return b.finish();
}

export function commentMarks(onSelect: (id: string) => void): Extension {
  return [
    marksField,
    marksDecorations,
    gutter({
      class: "cm-commentgutter",
      markers: gutterMarkers,
      domEventHandlers: {
        mousedown(view, line) {
          const st = view.state.field(marksField);
          const hit = st.items.find((m) => m.from >= line.from && m.from <= line.to);
          if (hit) onSelect(hit.id);
          return !!hit;
        },
      },
    }),
    EditorView.domEventHandlers({
      click(e) {
        const el = (e.target as HTMLElement).closest("[data-cid]") as HTMLElement | null;
        if (el?.dataset.cid) onSelect(el.dataset.cid);
        return false;
      },
    }),
    hoverTooltip((view, pos) => {
      const st = view.state.field(marksField);
      const hits = st.items.filter((m) => pos >= m.from && pos <= m.to && !m.block);
      if (!hits.length) return null;
      return {
        pos: hits[0].from,
        end: hits[0].to,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-ctip";
          for (const h of hits.slice(0, 3)) {
            const row = document.createElement("div");
            row.className = "cm-ctip-row";
            row.style.setProperty("--c", h.colour);
            const t = document.createElement("strong");
            t.textContent = h.title;
            const p = document.createElement("div");
            p.textContent = h.hint;
            row.append(t, p);
            row.onmousedown = (e) => {
              e.preventDefault();
              onSelect(h.id);
            };
            dom.appendChild(row);
          }
          return { dom };
        },
      };
    }, { hoverTime: 350 }),
  ];
}

export function markPosition(view: EditorView, id: string): { from: number; to: number } | null {
  const m = view.state.field(marksField).items.find((x) => x.id === id);
  return m ? { from: m.from, to: m.to } : null;
}

export function locallyStale(view: EditorView): Set<string> {
  return new Set(view.state.field(marksField).items.filter((m) => m.stale).map((m) => m.id));
}
