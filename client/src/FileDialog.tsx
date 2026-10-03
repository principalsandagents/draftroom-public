import { useEffect, useState } from "react";
import { api, type BrowseData } from "./api.ts";
import { ago } from "./advice/util.ts";

interface Props {
  start?: string;
  onOpen: (path: string) => void;
  onClose: () => void;
  onImport?: (dir: string) => void;
  onNew?: (dir: string) => void;
}

export function FileDialog({ start, onOpen, onClose, onImport, onNew }: Props) {
  const [data, setData] = useState<BrowseData | null>(null);
  const [err, setErr] = useState("");
  const [typed, setTyped] = useState("");
  const [recent, setRecent] = useState<Array<{ path: string; action: string; at: string }>>([]);
  useEffect(() => { api.recent().then((r) => setRecent(r.recent)).catch(() => setRecent([])); }, []);
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
  const go = (dir?: string) => api.browse(dir).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { go(start); }, [start]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Open a draft</strong>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (typed) onOpen(typed); }}>
          <input placeholder="Paste a path to a .md file or a post folder" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </form>
        {recent.length > 0 && (
          <div className="recent">
            <div className="recent-head">Recent</div>
            <ul className="browse">
              {recent.map((r) => (
                <li key={r.path} onClick={() => onOpen(r.path)} title={r.path}>
                  <span className="recent-name">
                    <strong>{r.path.split("/").pop()}</strong>
                    <span className="muted small"> {home(r.path.split("/").slice(0, -1).join("/"))}</span>
                  </span>
                  <span className="muted small recent-when">{r.action} {ago(r.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {err && <p className="error">{err}</p>}
        {data && (
          <>
            <div className="muted small crumbs">{data.dir}{onNew && <button className="link" onClick={() => onNew(data.dir)}>New draft here…</button>}{onImport && <button className="link" onClick={() => onImport(data.dir)}>Import a Word file here…</button>}</div>
            <ul className="browse">
              {data.parent && <li onClick={() => go(data.parent!)}>⬑ ..</li>}
              {data.entries.map((e) => (
                <li key={e.path} onClick={() => (e.dir ? go(e.path) : onOpen(e.path))} className={e.dir ? "dir" : "md"}>
                  {e.dir ? "▸ " : ""}{e.name}
                  {e.dir && <button className="link" onClick={(ev) => { ev.stopPropagation(); onOpen(e.path); }}>open folder's draft</button>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
