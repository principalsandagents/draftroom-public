import type { ArticleContext, Comment, EngineName, PerspectiveMeta, Scope, Sidecar } from "../../../shared/types.ts";
import { Card } from "./Card.tsx";
import { Overview } from "./Overview.tsx";
import { RunBar, type Running } from "./RunBar.tsx";
import { ContextStrip } from "../context/ContextStrip.tsx";
import { JevPanel } from "./JevPanel.tsx";
import { CitationsPanel } from "./CitationsPanel.tsx";
import type { CiteStatus } from "../api.ts";
import type { JevStatus } from "../api.ts";
import { applyFilters, byDocumentOrder, hocBlocked, isStale, type Detail, type Filters } from "./util.ts";

interface Props {
  tab: string;
  onTab: (t: string) => void;
  perspectives: PerspectiveMeta[];
  sidecar: Sidecar;
  localStale: Set<string>;
  detail: Detail;
  onDetail: (d: Detail) => void;
  filters: Filters;
  onFilters: (f: Filters) => void;
  activeId: string | null;
  onSelect: (c: Comment) => void;
  scope: Scope;
  engine: EngineName;
  estimate: number | null;
  running: Running[];
  hasSelection: boolean;
  onScope: (s: Scope) => void;
  onEngine: (e: EngineName) => void;
  onRun: () => void;
  onCancel: (r: Running) => void;
  onStatus: (c: Comment, status: Comment["status"], reason?: string | null) => void;
  onRecheck: (c: Comment) => void;
  onExample: (c: Comment) => void;
  onOpenLink: (target: string) => void;
  onUsualSet: () => void;
  usage: Record<string, number>;
  examplesPerDay: number;
  context: ArticleContext;
  contextSaved: boolean;
  voices: Array<{ key: string; label: string }>;
  onSaveContext: (c: ArticleContext) => Promise<void>;
  lastMessage: Record<string, string>;
  cite: { status: CiteStatus | null; busy: string; message: string; onStyle: (s: string) => void; onRenumber: () => void; onConvert: (from: "FN" | "EN", to: "FN" | "EN") => void; onCheck: () => void; onLink: (label: string, file: File) => void; onFormat: () => void; onValidate: () => void };
  jev: { status: JevStatus | null; busy: boolean; last: string; onEnable: () => void; onDisable: () => void; onRescore: () => void };
}

const SEVS = ["must", "should", "consider"];
const LVLS = ["argument", "structure", "paragraph", "sentence", "mechanics"];

export function Panel(props: Props) {
  const { tab, perspectives, sidecar, filters, detail } = props;
  const p = perspectives.find((x) => x.id === tab);
  const toggle = (set: Set<string>, v: string) => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    return n;
  };
  const busy = props.running.length >= 3;

  let list: Comment[] = [];
  if (p) {
    list = applyFilters(sidecar.comments.filter((c) => c.perspective === p.id), filters, props.localStale).sort(byDocumentOrder);
  }
  const hiddenByHoc = filters.hocFirst && hocBlocked(sidecar.comments);

  return (
    <aside className="panel">
      <nav className="tabs">
        <button className={tab === "overview" ? "on" : ""} onClick={() => props.onTab("overview")}>Overview</button>
        {perspectives.map((x) => {
          const n = sidecar.comments.filter((c) => c.perspective === x.id && c.status === "open").length;
          return (
            <button key={x.id} className={tab === x.id ? "on" : ""} style={{ ["--c" as any]: x.colour }} onClick={() => props.onTab(x.id)} title={`Ctrl-Shift-${x.shortcut}`}>
              <span className="dot" />{x.name}{x.engine === "jev" && <span className="jev-tag">[Jev]</span>}{n > 0 && <span className="count">{n}</span>}
            </button>
          );
        })}
        <button className={tab === "context" ? "on" : ""} onClick={() => props.onTab("context")}>Context</button>
      </nav>

      <div className="panel-body">
        {tab === "overview" && (
          <Overview sidecar={sidecar} perspectives={perspectives} usage={props.usage} onTab={props.onTab} onSelect={props.onSelect} onUsualSet={props.onUsualSet} examplesPerDay={props.examplesPerDay} />
        )}
        {tab === "context" && <ContextStrip context={props.context} voices={props.voices} saved={props.contextSaved} onSave={props.onSaveContext} />}
        {p && (
          <>
            {p.runnable !== false ? <RunBar p={p} scope={props.scope} engine={props.engine} estimate={props.estimate} running={props.running} hasSelection={props.hasSelection}
              onScope={props.onScope} onEngine={props.onEngine} onRun={props.onRun} onCancel={props.onCancel} /> : p.engine === "jev" ? <JevPanel {...props.jev} /> : p.engine === "cite" ? <CitationsPanel {...props.cite} /> : <p className="muted small">{p.note ?? ""}</p>}
            {props.lastMessage[p.id] && props.lastMessage[p.id] !== sidecar.summaries[p.id]?.summary && <p className="lastmsg small">{props.lastMessage[p.id]}</p>}
            {sidecar.summaries[p.id] && <p className="summary">{sidecar.summaries[p.id].summary}</p>}
            <div className="filters">
              <div className="seg small" role="group" aria-label="Detail">
                {(["summary", "cards", "full"] as Detail[]).map((d) => (
                  <button key={d} className={detail === d ? "on" : ""} onClick={() => props.onDetail(d)}>{d}</button>
                ))}
              </div>
              <select className="small" value={filters.status} onChange={(e) => props.onFilters({ ...filters, status: e.target.value as Filters["status"] })}>
                <option value="open">open</option>
                <option value="stale">stale</option>
                <option value="resolved">resolved</option>
                <option value="dismissed">dismissed</option>
                <option value="all">all</option>
              </select>
              <div className="chips">
                {SEVS.map((s) => (
                  <button key={s} className={`chipbtn${filters.severities.has(s) ? " on" : ""}`} onClick={() => props.onFilters({ ...filters, severities: toggle(filters.severities, s) })}>{s}</button>
                ))}
                {LVLS.map((l) => (
                  <button key={l} className={`chipbtn${filters.levels.has(l) ? " on" : ""}`} onClick={() => props.onFilters({ ...filters, levels: toggle(filters.levels, l) })}>{l}</button>
                ))}
              </div>
              <label className="small hoc">
                <input type="checkbox" checked={filters.hocFirst} onChange={(e) => props.onFilters({ ...filters, hocFirst: e.target.checked })} />
                Argument and structure first
              </label>
            </div>
            {hiddenByHoc && (p.level === "sentence" || p.level === "mechanics") && (
              <p className="muted small">Sentence and mechanics comments are hidden while argument or structure comments are open. Untick "Argument and structure first" to see them.</p>
            )}
            <div className="cards">
              {list.length === 0 && <p className="muted">{sidecar.summaries[p.id] ? "Nothing here with these filters." : `Not run yet on this draft. Pick a scope and click Run.`}</p>}
              {list.map((c) => (
                <Card key={c.id} c={c} p={p} detail={detail} active={props.activeId === c.id} stale={isStale(c, props.localStale)} busy={busy}
                  onSelect={() => props.onSelect(c)} onStatus={(s, r) => props.onStatus(c, s, r)} onRecheck={() => props.onRecheck(c)}
                  onExample={() => props.onExample(c)} onOpenLink={props.onOpenLink} />
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
