// The Signals [Jev] tab header: per-draft switch (enforced by the server), consent notice,
// status, each question's trial state and precision, and today's cost.

import { useState } from "react";
import type { JevStatus } from "../api.ts";

interface Props {
  status: JevStatus | null;
  busy: boolean;
  last: string;
  onEnable: () => void;
  onDisable: () => void;
  onRescore: () => void;
}

export function JevPanel({ status, busy, last, onEnable, onDisable, onRescore }: Props) {
  const [asking, setAsking] = useState(false);
  if (!status) return <p className="muted small">Loading Jev status…</p>;
  const on = status.enabled && !status.reason;
  const blocked = status.reason && status.reason !== "Switched off for this draft";
  return (
    <div className="jevpanel">
      <div className="jev-row">
        <span className="jev-tag">[Jev]</span>
        <strong>Signals</strong>
        <span className="spacer" />
        {status.enabled ? (
          <button onClick={onDisable}>Switch off</button>
        ) : (
          <button className="primary" disabled={!!blocked} onClick={() => (status.consented ? onEnable() : setAsking(true))}>Switch on for this draft</button>
        )}
      </div>
      {asking && !status.enabled && (
        <div className="jev-consent">
          <p>{status.consent_text}</p>
          <button className="primary" onClick={() => { setAsking(false); onEnable(); }}>Send and switch on</button>{" "}
          <button onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}
      <p className="muted small">
        {status.reason ?? (busy ? "Scoring…" : last || "On: paragraphs are re-checked a few seconds after you pause.")}
        {on && !busy && <button className="link" onClick={onRescore}>Re-check now</button>}
      </p>
      {status.questions && (
        <details className="jev-questions">
          <summary className="small">Questions ({status.questions.filter((q) => q.enabled).length} on)</summary>
          <ul>
            {status.questions.map((q) => (
              <li key={q.key} className={q.enabled ? "" : "muted"}>
                {q.title}
                <span className="muted small">
                  {!q.enabled ? " · off" : q.trial ? ` · trial${q.outcomes ? ` (${q.outcomes} outcomes, ${Math.round((q.precision ?? 0) * 100)}% kept)` : ""}` : ` · graduated (${Math.round((q.precision ?? 0) * 100)}%)`}
                  {q.retire ? " · consider switching off" : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">Edit questions and thresholds in perspectives/jev-signals.yaml. Resolve a card if the signal was right; dismiss it as "disagree" if it was wrong.</p>
        </details>
      )}
      <p className="muted small">Today: {status.today.calls} calls, {status.today.tokens.toLocaleString()} tokens, about US${status.today.cost_usd.toFixed(4)}{status.model ? ` · ${status.model}` : ""}</p>
    </div>
  );
}
