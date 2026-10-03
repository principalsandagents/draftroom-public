import { useEffect, useState } from "react";
import type { EngineName, PerspectiveMeta, Scope } from "../../../shared/types.ts";
import { SCOPE_LABEL } from "./util.ts";

export interface Running {
  key: string;
  run_id?: string;
  perspective: string;
  engine: EngineName;
  scope: Scope;
  started: number;
}

interface Props {
  p: PerspectiveMeta;
  scope: Scope;
  engine: EngineName;
  estimate: number | null;
  running: Running[];
  hasSelection: boolean;
  onScope: (s: Scope) => void;
  onEngine: (e: EngineName) => void;
  onRun: () => void;
  onCancel: (r: Running) => void;
}

export function RunBar({ p, scope, engine, estimate, running, hasSelection, onScope, onEngine, onRun, onCancel }: Props) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running.length]);
  const isLint = p.engine === "lint";
  const mine = running.filter((r) => r.perspective === p.id);
  return (
    <div className="runbar">
      <div className="runbar-row">
        <select value={scope} onChange={(e) => onScope(e.target.value as Scope)} aria-label="Scope">
          {p.scopes.map((s) => (
            <option key={s} value={s} disabled={s === "selection" && !hasSelection}>{SCOPE_LABEL[s]}</option>
          ))}
        </select>
        {!isLint && (
          <div className="seg" role="group" aria-label="Engine">
            {(["claude", "codex"] as EngineName[]).map((e) => (
              <button key={e} className={engine === e ? "on" : ""} onClick={() => onEngine(e)}>{e === "claude" ? "Claude" : "Codex"}</button>
            ))}
          </div>
        )}
        <button className="primary" onClick={onRun} disabled={scope === "selection" && !hasSelection}>Run {p.name}</button>
      </div>
      <div className="runbar-est muted">
        {isLint ? "No model, no tokens." : estimate !== null ? `About ${estimate.toLocaleString()} input tokens.` : "Estimating…"}
      </div>
      {running.length > 0 && (
        <ul className="running">
          {running.map((r) => (
            <li key={r.key} className={mine.includes(r) ? "" : "muted"}>
              <span className="spinner" /> {r.perspective} · {r.engine} · {SCOPE_LABEL[r.scope]} · {Math.round((Date.now() - r.started) / 1000)}s
              {r.run_id && <button className="link" onClick={() => onCancel(r)}>Cancel</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
