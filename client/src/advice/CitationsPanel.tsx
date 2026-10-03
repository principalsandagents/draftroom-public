// Citations tab: style, renumbering, footnote/endnote conversion, the quote check, and
// Link a file for notes whose source cannot be fetched.

import type { CiteStatus } from "../api.ts";

interface Props {
  status: CiteStatus | null;
  busy: string;
  message: string;
  onStyle: (s: string) => void;
  onRenumber: () => void;
  onConvert: (from: "FN" | "EN", to: "FN" | "EN") => void;
  onCheck: () => void;
  onLink: (label: string, file: File) => void;
  onFormat: () => void;
  onValidate: () => void;
}

const ICON: Record<string, string> = { exact: "✓", close: "≈", not_found: "✗", not_checked: "?" };

const EXISTS: Record<string, [string, string]> = { found: ["✓", "found"], url_answers: ["✓", "page answers"], not_found: ["✗", "not found"], lead_only: ["!", "lead only"], not_checked: ["?", "not checked"] };
const SUPPORT: Record<string, [string, string]> = { supported: ["✓", "supports"], partly: ["≈", "partly supports"], not_supported: ["✗", "contradicts"], not_found_in_passages: ["?", "support not found"], not_verified: ["?", "not verified"], no_text: ["?", "no full text"], not_checked: ["?", "not checked"] };
const RELEVANCE: Record<string, [string, string]> = { relevant: ["✓", "relevant"], partly: ["≈", "partly relevant"], not_relevant: ["✗", "not relevant"], cannot_tell: ["?", "relevance unknown"] };

function Chip({ map, k, title }: { map: Record<string, [string, string]>; k: string; title?: string }) {
  const [icon, text] = map[k] ?? ["?", k];
  const cls = icon === "✓" ? "ok" : icon === "✗" ? "bad" : icon === "≈" ? "mid" : "unk";
  return <span className={`vchip v-${cls}`} title={title}>{icon} {text}</span>;
}

export function CitationsPanel({ status, busy, message, onStyle, onRenumber, onConvert, onCheck, onLink, onFormat, onValidate }: Props) {
  if (!status) return <p className="muted small">Loading…</p>;
  const fn = status.notes.filter((n) => n.label.startsWith("FN")).length;
  const en = status.notes.filter((n) => n.label.startsWith("EN")).length;
  return (
    <div className="citepanel">
      <div className="cite-row">
        <label className="small">Style{" "}
          <select value={status.style ?? ""} onChange={(e) => onStyle(e.target.value)}>
            <option value="">(not set)</option>
            <option value="aglc4">AGLC 4</option>
            <option value="chicago18">Chicago 18 (notes)</option>
            <option value="apa7">APA 7</option>
          </select>
        </label>
        <button disabled={!!busy || !["aglc4", "chicago18"].includes(status.style ?? "")} onClick={onFormat} title={status.style === "apa7" ? "APA arrives in a later release" : "Preview every note in this style; nothing changes until you accept"}>Format citations…</button>
        {status.style === "apa7" && <span className="muted small">APA formatting arrives in a later release.</span>}
      </div>
      <div className="cite-row">
        <button disabled={!!busy} onClick={onRenumber} title="Number notes in reading order; also adopts plain [^1] labels">Renumber</button>
        <button disabled={!!busy || !fn} onClick={() => onConvert("FN", "EN")}>Footnotes → endnotes</button>
        <button disabled={!!busy || !en} onClick={() => onConvert("EN", "FN")}>Endnotes → footnotes</button>
        <button className="primary" disabled={!!busy} onClick={onCheck} title="Fetch each quoted note's source and match the quote word for word">Check quotes</button>
        <button className="primary" disabled={!!busy} onClick={onValidate} title="Check each reference exists, its details, whether it is relevant and supports the claim (uses Claude; a few minutes)">Validate references</button>
      </div>
      {status.positions_stale && <p className="small chip-warn">Notes have moved since citations were formatted: short forms such as ibid and "(n X)" may now point to the wrong note. Run Format citations again.</p>}
      <p className="muted small">{busy || message || `${fn} footnotes, ${en} endnotes.${status.checked_at ? ` Quotes last checked ${new Date(status.checked_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}.` : ""}`}</p>
      <ul className="cite-notes">
        {status.notes.map((n) => (
          <li key={n.label}>
            <div className="cite-head">
              <code>{n.label.replace(/-[a-z0-9]+$/, "")}</code>
              <span className="muted small">{n.host ?? (n.linked ? "linked file" : "no web address")}{n.refs === 0 ? " · not referenced" : n.refs > 1 ? ` · referenced ${n.refs}×` : ""}</span>
              {n.lead_only && <span className="chip chip-warn" title="Paid or licensed source: never fetched. Cite the primary source.">lead only</span>}
            </div>
            <div className="small cite-body">{n.body}</div>
            {n.quotes.map((q, i) => (
              <div key={i} className={`small cite-quote q-${q.status}`} title={q.detail}>
                <span className="cite-icon">{ICON[q.status]}</span> “{q.quote.slice(0, 80)}{q.quote.length > 80 ? "…" : ""}” <span className="muted">{q.detail.slice(0, 140)}</span>
              </div>
            ))}
            {n.validation?.sources.map((v, i) => (
              <div key={i} className="cite-val small" title={`Claim checked: ${n.validation!.claim}`}>
                <div className="muted">{v.label}</div>
                <div className="vchips">
                  <Chip map={EXISTS} k={v.exists.status} title={v.exists.detail} />
                  {v.details.status !== "not_checked" && <span className={`vchip v-${v.details.status === "ok" ? "ok" : "mid"}`} title={v.details.diffs.join("; ")}>{v.details.status === "ok" ? "✓ details match" : "≠ details differ"}</span>}
                  <Chip map={RELEVANCE} k={v.relevance.status} title={v.relevance.detail} />
                  <Chip map={SUPPORT} k={v.support.status} title={`${v.support.detail}${v.support.passage ? `\n\nPassage: “${v.support.passage}”${v.support.passage_verified ? " (found in the source)" : ""}` : ""}`} />
                  <span className={`vchip v-${v.fulltext.status === "none" || v.fulltext.status === "abstract_only" ? "unk" : "ok"}`} title={v.fulltext.detail}>{v.fulltext.status === "linked" ? "✓ linked file" : v.fulltext.status === "saved" ? "✓ full text saved" : v.fulltext.status === "abstract_only" ? "? abstract only" : "? no full text"}</span>
                </div>
              </div>
            ))}
            {(!n.url || n.quotes.some((q) => q.status === "not_checked") || n.validation?.sources.some((v) => v.fulltext.status === "none" || v.fulltext.status === "abstract_only")) && !n.lead_only && (
              <label className="link small cite-link">
                {n.linked ? "Replace linked file…" : "Link a file…"}
                <input type="file" accept=".pdf,.docx,.html,.htm,.txt,.md" onChange={(e) => { const f = e.target.files?.[0]; if (f) onLink(n.label, f); e.target.value = ""; }} />
              </label>
            )}
          </li>
        ))}
      </ul>
      {!status.notes.length && <p className="muted small">No footnotes or endnotes in this draft.</p>}
    </div>
  );
}
