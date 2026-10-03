// Release 1 article context: the fields every perspective reads. The full form and the
// Setup agent arrive in Release 2.

import { useEffect, useState } from "react";
import type { ArticleContext } from "../../../shared/types.ts";

const FORMATS = ["op-ed", "substack-take", "field-notes", "roundup", "report-chapter", "submission", "speech", "article", "other"];

interface Props {
  context: ArticleContext;
  voices: Array<{ key: string; label: string }>;
  saved: boolean;
  onSave: (c: ArticleContext) => Promise<void>;
}

export function ContextStrip({ context, voices, saved, onSave }: Props) {
  const [c, setC] = useState<ArticleContext>(context);
  const [msg, setMsg] = useState("");
  useEffect(() => setC(context), [context]);
  const set = (k: keyof ArticleContext, v: unknown) => setC((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      await onSave(c);
      setMsg("Saved");
    } catch (e) {
      setMsg((e as Error).message);
    }
    setTimeout(() => setMsg(""), 4000);
  };
  return (
    <div className="context">
      <p className="muted small">
        Every reviewer reads this. {saved ? "Saved beside the draft in .draftroom/." : "Pre-filled from the draft where possible; not saved yet."}
      </p>
      <label>Purpose<span className="muted"> · what the reader should think or do afterwards</span>
        <textarea rows={2} value={c.purpose ?? ""} onChange={(e) => set("purpose", e.target.value)} />
      </label>
      <label>Audience<span className="muted"> · who, what they know, what they believe now</span>
        <textarea rows={3} value={c.audience ?? ""} onChange={(e) => set("audience", e.target.value)} />
      </label>
      <label>Frame<span className="muted"> · the setting the piece is written from; reviewers judge examples against it</span>
        <input value={c.frame ?? ""} placeholder="e.g. Australian; International, Australia as the worked example; UK and EU" onChange={(e) => set("frame", e.target.value)} />
      </label>
      <label>Key claim
        <textarea rows={2} value={c.key_claim ?? ""} onChange={(e) => set("key_claim", e.target.value)} />
      </label>
      <div className="row2">
        <label>Format
          <select value={c.format ?? ""} onChange={(e) => set("format", e.target.value || undefined)}>
            <option value="">(not set)</option>
            {FORMATS.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label>Voice
          <select value={c.voice ?? ""} onChange={(e) => set("voice", e.target.value || undefined)}>
            <option value="">(not set)</option>
            {voices.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
          </select>
        </label>
      </div>
      <label>Publication
        <input value={c.publication ?? ""} onChange={(e) => set("publication", e.target.value)} />
      </label>
      <label>Length target (words)
        <input type="number" value={c.length_target ?? ""} onChange={(e) => set("length_target", e.target.value ? Number(e.target.value) : undefined)} />
      </label>
      <label>Sources file<span className="muted"> · absolute path, read by Evidence</span>
        <input value={c.sources_file ?? ""} onChange={(e) => set("sources_file", e.target.value)} />
      </label>
      <label>Reference folders<span className="muted"> · absolute paths, one per line; Evidence may read them</span>
        <textarea rows={2} value={(c.reference_folders ?? []).join("\n")} onChange={(e) => set("reference_folders", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} />
      </label>
      <label>Notes for reviewers
        <textarea rows={2} value={c.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <button className="primary" onClick={save}>Save context</button> <span className="muted small">{msg}</span>
    </div>
  );
}
