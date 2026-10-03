// One comment. Hints and examples carry no copy button, and examples cannot be selected:
// the words in the draft stay the writer's own.

import { useState } from "react";
import type { Comment, PerspectiveMeta } from "../../../shared/types.ts";
import type { Detail } from "./util.ts";

interface Props {
  c: Comment;
  p: PerspectiveMeta | undefined;
  detail: Detail;
  active: boolean;
  stale: boolean;
  busy: boolean;
  onSelect: () => void;
  onStatus: (status: Comment["status"], reason?: string | null) => void;
  onRecheck: () => void;
  onExample: () => void;
  onOpenLink: (target: string) => void;
}

const FLAG_LABEL: Record<string, string> = {
  fuzzy: "approximate anchor", tell: "reviewer tripped the lint", trimmed: "hint trimmed",
};

export function Card({ c, p, detail, active, stale, busy, onSelect, onStatus, onRecheck, onExample, onOpenLink }: Props) {
  const [dismissing, setDismissing] = useState(false);
  const colour = p?.colour ?? "#888";
  const full = detail === "full";
  return (
    <div
      className={`card${active ? " card-active" : ""}${c.status !== "open" ? " card-closed" : ""}`}
      style={{ ["--c" as any]: colour }}
      onClick={onSelect}
      id={`card-${c.id}`}
    >
      <div className="card-head">
        <span className={`sev sev-${c.severity}`} title={`severity: ${c.severity}`}>{c.severity}</span>
        <span className="card-title">{c.title}</span>
        {c.engine === "cite" && <span className="jev-tag cite-tag" title="From the Citations quote check: matched against the cited source, no model">[Cite]</span>}
        {c.engine === "jev" && <span className="jev-tag" title="A signal from TypeSafe's Jev: a probability, no model wording">[Jev]</span>}
        {c.flags.includes("trial") && <span className="chip" title="This question is still on trial: resolve if right, dismiss as disagree if wrong">trial</span>}
      </div>
      <div className="card-meta">
        <span className="chip">{c.level}</span>
        {!c.anchor && <span className="chip">whole draft</span>}
        {c.anchor && <span className="chip">{c.anchor.section ? `${c.anchor.section.slice(0, 28)} · ` : ""}¶{c.anchor.paragraph}</span>}
        {stale && c.status === "open" && <span className="chip chip-warn">stale</span>}
        {c.status !== "open" && <span className="chip">{c.status}{c.closed_at ? ` ${new Date(c.closed_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}{c.dismiss_reason ? `: ${c.dismiss_reason}` : ""}</span>}
        {full && c.flags.filter((f) => f !== "jev" && f !== "trial").map((f) => <span key={f} className="chip chip-flag">{FLAG_LABEL[f] ?? f}</span>)}
      </div>
      {detail !== "summary" && <p className="card-hint">{c.hint}</p>}
      {detail === "cards" && c.engine === "jev" && <p className="card-why small">{c.rationale}</p>}
      {full && c.anchor && <blockquote className="card-quote">{c.anchor.exact.length > 160 ? c.anchor.exact.slice(0, 160) + "…" : c.anchor.exact}</blockquote>}
      {full && <p className="card-why">{c.rationale}</p>}
      {full && c.links.length > 0 && (
        <ul className="card-links">
          {c.links.map((l, i) => (
            <li key={i}>
              <a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenLink(l.target); }}>{l.label}</a>
              <span className="muted"> · {l.why}</span>
            </li>
          ))}
        </ul>
      )}
      {full && c.proposed_source && (
        <div className="card-source">
          <span className="chip">{c.proposed_source.status}</span> {c.proposed_source.source}
          <div className="muted">supports: {c.proposed_source.supports}</div>
        </div>
      )}
      {c.example && detail !== "summary" && (
        <div className="card-example" onCopy={(e) => e.preventDefault()}>
          <div className="muted">Pattern on another topic</div>
          <p>{c.example.example}</p>
          <p className="muted">{c.example.principle}</p>
        </div>
      )}
      {active && (
        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          {c.status === "open" ? (
            <>
              <button onClick={() => onStatus("resolved")}>Resolve</button>
              {!dismissing && <button onClick={() => setDismissing(true)}>Dismiss…</button>}
              {dismissing && (
                <span className="dismiss">
                  {["intentional", "disagree", "out of scope"].map((r) => (
                    <button key={r} onClick={() => { setDismissing(false); onStatus("dismissed", r); }}>{r}</button>
                  ))}
                </span>
              )}
              {c.anchor && p?.runnable !== false && p?.engine !== "lint" && <button disabled={busy} onClick={onRecheck}>Recheck</button>}
              {!c.example && c.level !== "mechanics" && p?.runnable !== false && p?.engine !== "lint" && (
                <button disabled={busy} onClick={onExample} title="A before-and-after on an unrelated topic. Uses one model call.">Show an example</button>
              )}
            </>
          ) : (
            <button onClick={() => onStatus("open", null)}>Reopen</button>
          )}
        </div>
      )}
    </div>
  );
}
