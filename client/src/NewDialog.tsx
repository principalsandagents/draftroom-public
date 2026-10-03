// Start a new draft: a folder (created if missing), a title, and a file name from the title.

import { useState } from "react";
import { api } from "./api.ts";

export function fileNameFor(name: string): string {
  const slug = name.trim().replace(/\.md$/i, "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${slug || "untitled"}.md`;
}

export function NewDialog({ dir, onDone, onClose }: { dir: string; onDone: (path: string) => void; onClose: () => void }) {
  const [folder, setFolder] = useState(dir);
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const file = fileNameFor(name || title);
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      onDone((await api.newDraft(folder.trim(), title.trim(), name.trim())).path);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><strong>New draft</strong><button className="link" onClick={onClose}>Close</button></div>
        <form onSubmit={(e) => { e.preventDefault(); if (title.trim() || name.trim()) go(); }}>
          <label className="field">Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Working title" /></label>
          <label className="field">Folder<span className="muted"> · created if it does not exist</span><input value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
          <label className="field">File name<span className="muted"> · optional; taken from the title</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={file} /></label>
          <p className="muted small">Creates <code>{folder.replace(/\/+$/, "")}/{file}</code> with the title in its frontmatter and a body marker. An existing file is never replaced.</p>
          <button className="primary" type="submit" disabled={busy || !(title.trim() || name.trim())}>{busy ? "Creating…" : "Create and open"}</button>
          {err && <p className="error">{err}</p>}
        </form>
      </div>
    </div>
  );
}
