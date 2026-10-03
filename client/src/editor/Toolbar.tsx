// Formatting toolbar. Buttons act on the editor; the editor reports the state at the cursor.

import type { Block, FormatState, Mark } from "./format.ts";

export type FormatCommand = { mark: Mark } | { block: Block } | { link: true } | { note: "FN" | "EN" };

const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const K = (s: string) => (mac ? s : s.replace(/⌘/g, "Ctrl-").replace(/⌥/g, "Alt-").replace(/⇧/g, "Shift-"));

export function Toolbar({ state, onCommand, onImage }: { state: FormatState; onCommand: (c: FormatCommand) => void; onImage: (f: File) => void }) {
  // mousedown + preventDefault keeps the editor's selection while clicking a button.
  const btn = (label: React.ReactNode, title: string, cmd: FormatCommand, on = false, cls = "") => (
    <button className={`tb${on ? " on" : ""} ${cls}`} title={title} aria-pressed={on} onMouseDown={(e) => { e.preventDefault(); onCommand(cmd); }}>
      {label}
    </button>
  );
  const headingBlock = ["p", "h1", "h2", "h3"].includes(state.block) ? state.block : "p";
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <select className="tb-style" value={headingBlock} title={K("Style: ⌘⌥0 normal, ⌘⌥1–3 headings")}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => onCommand({ block: e.target.value as Block })}>
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="tb-sep" />
      {btn(<strong>B</strong>, K("Bold (⌘B)"), { mark: "bold" }, state.bold)}
      {btn(<em>I</em>, K("Italic (⌘I)"), { mark: "italic" }, state.italic)}
      {btn(<s>S</s>, K("Strikethrough (⌘⇧X)"), { mark: "strike" }, state.strike)}
      <span className="tb-sep" />
      {btn("• List", K("Bulleted list (⌘⇧8)"), { block: "bullet" }, state.block === "bullet")}
      {btn("1. List", K("Numbered list (⌘⇧7)"), { block: "number" }, state.block === "number")}
      {btn("❝ Quote", K("Quote (⌘⇧9)"), { block: "quote" }, state.block === "quote")}
      <span className="tb-sep" />
      {btn("Link", K("Link (⌘K)"), { link: true })}
      {btn("Footnote", K("Insert a footnote (⌘⌥F)"), { note: "FN" })}
      {btn("Endnote", K("Insert an endnote (⌘⌥E)"), { note: "EN" })}
      <span className="tb-sep" />
      <label className="tb" title="Insert an image at the cursor (or paste or drag one into the draft). It is saved in an images folder beside the draft." onMouseDown={(e) => e.preventDefault()}>
        Image
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onImage(f); }} />
      </label>
    </div>
  );
}
