import type { Comment, PerspectiveMeta, Sidecar } from "../../../shared/types.ts";
import { LEVELS } from "../../../shared/types.ts";
import { ago, rank } from "./util.ts";

interface Props {
  sidecar: Sidecar;
  perspectives: PerspectiveMeta[];
  usage: Record<string, number>;
  onTab: (id: string) => void;
  onSelect: (c: Comment) => void;
  onUsualSet: () => void;
  examplesPerDay: number;
}

export function Overview({ sidecar, perspectives, usage, onTab, onSelect, onUsualSet, examplesPerDay }: Props) {
  const open = sidecar.comments.filter((c) => c.status === "open");
  // Jev signals have their own row; the top five are the reviewers' comments.
  const top = [...open].filter((c) => c.anchor && c.engine !== "jev").sort((a, b) => rank(a) - rank(b)).slice(0, 5);
  const docPoints = open.filter((c) => !c.anchor);
  const colour = (id: string) => perspectives.find((p) => p.id === id)?.colour ?? "#888";
  return (
    <div className="overview">
      <section>
        <h3>By perspective</h3>
        <ul className="ov-list">
          {perspectives.map((p) => {
            const mine = open.filter((c) => c.perspective === p.id);
            const s = sidecar.summaries[p.id];
            const count = (sev: string) => mine.filter((c) => c.severity === sev).length;
            return (
              <li key={p.id} onClick={() => onTab(p.id)} style={{ ["--c" as any]: p.colour }}>
                <div className="ov-row">
                  <span className="dot" />
                  <strong>{p.name}</strong>
                  <span className="muted">{s ? ago(s.at) : "not run"}</span>
                  <span className="ov-counts">
                    {count("must") > 0 && <span className="sev sev-must">{count("must")}</span>}
                    {count("should") > 0 && <span className="sev sev-should">{count("should")}</span>}
                    {count("consider") > 0 && <span className="sev sev-consider">{count("consider")}</span>}
                  </span>
                </div>
                {s && <p className="ov-summary">{s.summary}</p>}
              </li>
            );
          })}
        </ul>
        <button onClick={onUsualSet}>Run the usual set</button>
        <span className="muted small"> Lint, Argument and Evidence over the whole draft.</span>
      </section>
      {top.length > 0 && (
        <section>
          <h3>Most important open items</h3>
          <ol className="ov-top">
            {top.map((c) => (
              <li key={c.id} onClick={() => onSelect(c)} style={{ ["--c" as any]: colour(c.perspective) }}>
                <span className={`sev sev-${c.severity}`}>{c.severity}</span> <strong>{c.title}</strong>
                <div className="muted small">{c.level} · ¶{c.anchor?.paragraph} · {perspectives.find((p) => p.id === c.perspective)?.name}</div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {docPoints.length > 0 && (
        <section>
          <h3>Whole-draft advice</h3>
          {LEVELS.filter((l) => docPoints.some((d) => d.level === l)).map((l) => (
            <div key={l}>
              <h4>{l}</h4>
              <ul className="ov-doc">
                {docPoints.filter((d) => d.level === l).sort((a, b) => rank(a) - rank(b)).map((d) => (
                  <li key={d.id} onClick={() => onSelect(d)} style={{ ["--c" as any]: colour(d.perspective) }}>
                    <strong>{d.title}</strong>
                    <p>{d.hint}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      <section className="muted small">
        Runs today: Claude {usage.claude ?? 0}, Codex {usage.codex ?? 0}, Lint {usage.lint ?? 0}. Examples {usage.examples ?? 0} of {examplesPerDay}.
      </section>
    </div>
  );
}
