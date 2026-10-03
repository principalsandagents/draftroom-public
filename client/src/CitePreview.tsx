// Before and after for each note; nothing changes until Accept. Applied by the caller through
// the editor, and only where the note still reads as it did when the preview was made.

import { useState } from "react";
import type { CitePreviewData } from "./api.ts";

interface Props {
  preview: CitePreviewData;
  onAccept: (labels: string[]) => void;
  onClose: () => void;
}

const STYLE_NAME: Record<string, string> = { aglc4: "AGLC 4", chicago18: "Chicago 18" };

export function CitePreview({ preview, onAccept, onClose }: Props) {
  // Notes that would lose words start unticked.
  const [chosen, setChosen] = useState<Set<string>>(new Set(preview.entries.filter((e) => !e.lossy).map((e) => e.label)));
  const toggle = (l: string) => setChosen((s) => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); return n; });
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Format citations in {STYLE_NAME[preview.style] ?? preview.style}</strong>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        <p className="muted small">
          {preview.entries.length} note{preview.entries.length === 1 ? "" : "s"} would change, {preview.unchanged} already match.
          Your own words in a note are never changed; only the citation part is rewritten. Nothing changes until you accept, and Cmd-Z undoes it.
        </p>
        {preview.skipped.length > 0 && (
          <p className="small error">Left as written: {preview.skipped.map((s) => `${s.label.replace(/-[a-z0-9]+$/, "")} (${s.reason})`).join("; ")}</p>
        )}
        <div className="preview-list">
          {preview.entries.map((e) => (
            <div key={e.label} className={`preview-item${chosen.has(e.label) ? "" : " off"}`}>
              <label className="check"><input type="checkbox" checked={chosen.has(e.label)} onChange={() => toggle(e.label)} /> <code>{e.label.replace(/-[a-z0-9]+$/, "")}</code></label>
              <div className="pv-before"><span className="muted small">Now</span><div>{e.before}</div></div>
              <div className="pv-after"><span className="muted small">After</span><div>{e.after}</div></div>
              {e.filled.map((f, i) => <div key={i} className="small muted">Added {f.field} “{f.value}” from {f.from}.</div>)}
              {e.warnings.map((w, i) => <div key={i} className="small chip-warn">{w}</div>)}
            </div>
          ))}
        </div>
        <div className="cite-row">
          <button className="primary" disabled={!chosen.size} onClick={() => onAccept([...chosen])}>Accept {chosen.size === preview.entries.length ? "all" : `${chosen.size} selected`}</button>
          <button onClick={() => setChosen(new Set())}>Select none</button>
          <button onClick={() => setChosen(new Set(preview.entries.map((e) => e.label)))}>Select all</button>
        </div>
      </div>
    </div>
  );
}
