// Import a Word file into a folder; export the open draft to Word.

import { useEffect, useState } from "react";
import { api, type ExportOptions, type ExportReport, type ImportReport } from "./api.ts";

export function ImportDialog({ dir, onDone, onClose }: { dir: string; onDone: (path: string) => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [folder, setFolder] = useState(dir);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ path: string; report: ImportReport } | null>(null);
  const go = async () => {
    if (!file) return;
    setBusy(true);
    setErr("");
    try {
      setDone(await api.importDocx(file, folder));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const r = done?.report;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><strong>Import a Word document</strong><button className="link" onClick={onClose}>Close</button></div>
        {!done && (
          <>
            <p className="muted small">
              Keeps the text, headings, lists, tables, footnotes, endnotes, comments and images. Drops headers, footers, page
              numbers, the table of contents and Word styling. Tracked insertions are accepted and deletions dropped.
            </p>
            <label className="field">Word file<input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
            <label className="field">Save into folder<input value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
            <p className="muted small">Writes <code>{file ? file.name.replace(/\.docx$/i, "") : "name"}.md</code> and an <code>images/</code> folder there. Word comments go into the Word comments tab.</p>
            <button className="primary" disabled={!file || busy} onClick={go}>{busy ? "Importing…" : "Import"}</button>
            {err && <p className="error">{err}</p>}
          </>
        )}
        {done && r && (
          <>
            <p><strong>Imported</strong> to <code>{done.path}</code></p>
            <ul className="report">
              <li>{r.headings} headings, {r.paragraphs} paragraphs</li>
              <li>{r.footnotes} footnotes (FN…) and {r.endnotes} endnotes (EN…)</li>
              <li>{r.tables.pipe + r.tables.grid} tables ({r.tables.grid} with merged cells or several paragraphs, kept as grid tables)</li>
              <li>{r.images.length} images saved in images/</li>
              <li>{r.comments} Word comments</li>
              <li className="muted">Removed: {r.removed.tocEntries} contents entries, {r.removed.trackedDeletions} tracked deletions, {r.removed.emptyParagraphs} empty paragraphs</li>
              {r.warnings.map((w, i) => <li key={i} className="error">{w}</li>)}
            </ul>
            <button className="primary" onClick={() => onDone(done.path)}>Open it</button>
          </>
        )}
      </div>
    </div>
  );
}

const STORE = "draftroom:export";

export function ExportDialog({ path, hasBody, getText, onClose }: { path: string; hasBody: boolean; getText: () => string; onClose: () => void }) {
  const [templates, setTemplates] = useState<Array<{ id: string; label: string }>>([]);
  const [pandoc, setPandoc] = useState("");
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORE) ?? "{}");
    } catch {
      return {};
    }
  })();
  const [o, setO] = useState<ExportOptions & { custom: string }>({
    template: saved.template ?? "report", custom: saved.custom ?? "", scope: hasBody ? "body" : "all", title_block: saved.title_block ?? true,
    notes: saved.notes ?? "as-labelled", comments: saved.comments ?? "none", out_path: path.replace(/\.md$/i, ".docx"), overwrite: false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [exists, setExists] = useState(false);
  const [done, setDone] = useState<ExportReport | null>(null);
  useEffect(() => {
    api.templates().then((t) => { setTemplates(t.templates); setPandoc(t.pandoc); }).catch((e) => setErr(e.message));
  }, []);
  const set = (k: string, v: unknown) => setO((x) => ({ ...x, [k]: v }));
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      const { custom, ...rest } = o;
      const opts = { ...rest, template: o.template === "custom" ? custom : o.template };
      try {
        localStorage.setItem(STORE, JSON.stringify({ template: o.template, custom, title_block: o.title_block, notes: o.notes, comments: o.comments }));
      } catch {
        /* private window */
      }
      setDone(await api.exportDocx(path, getText(), opts));
    } catch (e) {
      const x = e as Error & { status?: number };
      if (x.status === 409) setExists(true);
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><strong>Export to Word</strong><button className="link" onClick={onClose}>Close</button></div>
        {!done && (
          <>
            <label className="field">Style
              <select value={o.template} onChange={(e) => set("template", e.target.value)}>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                <option value="custom">Styles from another Word file…</option>
              </select>
            </label>
            {o.template === "custom" && (
              <label className="field">Word file to take styles, page set-up, header and footer from<span className="muted"> · absolute path to a .docx</span>
                <input value={o.custom} onChange={(e) => set("custom", e.target.value)} placeholder="~/Documents/Template.docx" />
              </label>
            )}
            <label className="field">Notes
              <select value={o.notes} onChange={(e) => set("notes", e.target.value)}>
                <option value="as-labelled">As labelled: FN… as footnotes, EN… as endnotes</option>
                <option value="footnotes">All as footnotes</option>
                <option value="endnotes">All as endnotes</option>
              </select>
            </label>
            <label className="field">Comments
              <select value={o.comments} onChange={(e) => set("comments", e.target.value)}>
                <option value="none">None</option>
                <option value="word">Open Word comments (from import)</option>
                <option value="all">All open comments, including reviewers'</option>
              </select>
            </label>
            {hasBody && (
              <label className="field">Content
                <select value={o.scope} onChange={(e) => set("scope", e.target.value)}>
                  <option value="body">The piece (after the Prep block)</option>
                  <option value="all">Everything, including Prep</option>
                </select>
              </label>
            )}
            {o.comments === "all" && <label className="check"><input type="checkbox" checked={!!o.include_jev} onChange={(e) => set("include_jev", e.target.checked)} /> Include Jev signals</label>}
            <label className="check"><input type="checkbox" checked={o.title_block} onChange={(e) => set("title_block", e.target.checked)} /> Title, subtitle, author and date from the frontmatter</label>
            <label className="field">Save as<input value={o.out_path} onChange={(e) => { set("out_path", e.target.value); setExists(false); }} /></label>
            {exists && <label className="check"><input type="checkbox" checked={!!o.overwrite} onChange={(e) => set("overwrite", e.target.checked)} /> Replace the existing file</label>}
            <button className="primary" disabled={busy || (o.template === "custom" && !o.custom)} onClick={go}>{busy ? "Exporting…" : "Export"}</button>
            {err && <p className="error">{err}</p>}
            <p className="muted small">{pandoc}</p>
          </>
        )}
        {done && (
          <>
            <p><strong>Exported</strong> to <code>{done.outPath}</code></p>
            <ul className="report">
              <li>{done.footnotes} footnotes, {done.endnotes} endnotes</li>
              <li>{done.tables} tables, {done.images} images</li>
              <li>{done.comments} comments{done.commentsCollapsed ? ` (${done.commentsCollapsed} placed at a point because their text crossed formatting or sat in a table)` : ""}</li>
              {done.warnings.map((w, i) => <li key={i} className="error">{w}</li>)}
            </ul>
            <button onClick={() => api.reveal(done.outPath)}>Show in Finder</button> <button onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}
