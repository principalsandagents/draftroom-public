import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type State } from "./api.ts";
import { Editor, type EditorHandle } from "./editor/Editor.tsx";
import { Panel } from "./advice/Panel.tsx";
import { FileDialog } from "./FileDialog.tsx";
import { Drawer } from "./Drawer.tsx";
import { ImportDialog, ExportDialog } from "./WordDialogs.tsx";
import { NewDialog } from "./NewDialog.tsx";
import { Toolbar } from "./editor/Toolbar.tsx";
import type { FormatState } from "./editor/format.ts";
import type { JevStatus, CiteStatus } from "./api.ts";
import { renumberNotes, convertNotes, parseNotes, replaceDefinitionBodies } from "../../shared/notes.ts";
import { CitePreview } from "./CitePreview.tsx";
import type { CitePreviewData } from "./api.ts";
import type { Running } from "./advice/RunBar.tsx";
import { applyFilters, BLOCK_LEVELS, byDocumentOrder, recheckScope, type Detail, type Filters } from "./advice/util.ts";
import type { MarkComment } from "./editor/marks.ts";
import type { ArticleContext, Comment, EngineName, PerspectiveMeta, RunEvent, Scope, Sidecar } from "../../shared/types.ts";
import { wordCount } from "../../shared/doc.ts";

const EMPTY: Sidecar = { version: 1, file_hash: "", comments: [], summaries: {}, dropped: {} };
const AUTOSAVE_MS = 20_000;

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(`draftroom:${k}`);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function store(k: string, v: unknown) {
  try {
    localStorage.setItem(`draftroom:${k}`, JSON.stringify(v));
  } catch {
    /* private window */
  }
}

export function App() {
  const ed = useRef<EditorHandle>(null);
  const [st, setSt] = useState<State | null>(null);
  const [file, setFile] = useState<{ path: string; hash: string } | null>(null);
  const [initial, setInitial] = useState<string | null>(null);
  const [words, setWords] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [sidecar, setSidecar] = useState<Sidecar>(EMPTY);
  const [localStale, setLocalStale] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(() => load("tab", "overview"));
  const [scopes, setScopes] = useState<Record<string, Scope>>({});
  const [engines, setEngines] = useState<Record<string, EngineName>>({});
  const [estimate, setEstimate] = useState<number | null>(null);
  const [running, setRunning] = useState<Running[]>([]);
  const [detail, setDetail] = useState<Detail>(() => load("detail", "cards"));
  const [filters, setFilters] = useState<Filters>({ severities: new Set(), levels: new Set(), status: "open", hocFirst: load("hocFirst", false) });
  const [mode, setMode] = useState<"draft" | "review">(() => load("mode", "review"));
  const [external, setExternal] = useState<{ hash: string } | null>(null);
  const [ctx, setCtx] = useState<{ context: ArticleContext; saved: boolean }>({ context: {}, saved: false });
  const [dialog, setDialog] = useState(false);
  const [importDir, setImportDir] = useState<string | null>(null);
  const [newDir, setNewDir] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [drawer, setDrawer] = useState<{ path: string; content: string } | null>(null);
  const [lastMessage, setLastMessage] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState(false);
  const [fmt, setFmt] = useState<FormatState>({ block: "p", bold: false, italic: false, strike: false });
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const [citeStatus, setCiteStatus] = useState<CiteStatus | null>(null);
  const [citeBusy, setCiteBusy] = useState("");
  const [citeMsg, setCiteMsg] = useState("");
  const [citePreview, setCitePreview] = useState<CitePreviewData | null>(null);
  const [jevStatus, setJevStatus] = useState<JevStatus | null>(null);
  const [jevBusy, setJevBusy] = useState(false);
  const [jevLast, setJevLast] = useState("");
  const jevTimer = useRef<number | undefined>(undefined);
  const jevOnRef = useRef(false);
  const fileRef = useRef(file);
  fileRef.current = file;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const perspectives: PerspectiveMeta[] = useMemo(() => (st?.perspectives ?? []).filter((p) => p.release === 1), [st]);
  const pOf = (id: string) => perspectives.find((p) => p.id === id);
  const text = () => ed.current?.getText() ?? "";

  useEffect(() => store("tab", tab), [tab]);
  useEffect(() => store("detail", detail), [detail]);
  useEffect(() => store("mode", mode), [mode]);
  useEffect(() => store("hocFirst", filters.hocFirst), [filters.hocFirst]);

  const refreshState = useCallback(() => api.state().then(setSt).catch((e) => setError(e.message)), []);

  const reloadComments = useCallback(async () => {
    const f = fileRef.current;
    if (!f) return;
    try {
      setSidecar(await api.comments(f.path, text()));
      setLocalStale(new Set());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const openPath = useCallback(async (p: string) => {
    if (dirtyRef.current && !confirm("Unsaved changes will be lost. Open anyway?")) return;
    try {
      const f = await api.open(p);
      setFile({ path: f.path, hash: f.hash });
      setInitial(f.content);
      ed.current?.setText(f.content);
      setWords(f.words);
      setDirty(false);
      setExternal(null);
      setDialog(false);
      setActiveId(null);
      setSidecar(await api.comments(f.path, f.content));
      setCtx(await api.context(f.path, f.content));
      const js = await api.jevStatus(f.path).catch(() => null);
      setJevStatus(js);
      jevOnRef.current = !!js && js.enabled && !js.reason;
      if (jevOnRef.current) setTimeout(() => jevScoreNow(), 300);
      document.title = `${f.path.split("/").slice(-2).join("/")} · Draftroom`;
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Start-up.
  useEffect(() => {
    api.state().then((s) => {
      setSt(s);
      // A file named on the command line (or opened earlier in this server run) opens;
      // otherwise the page stays empty until the writer opens, imports or creates something.
      if (s.file) openPath(s.file);
    }).catch((e) => setError(e.message));
  }, [openPath]);

  // Server events.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as RunEvent;
      if (e.type === "run-start") {
        setRunning((rs) => {
          const i = rs.findIndex((r) => !r.run_id && r.perspective === e.perspective);
          if (i < 0) return rs;
          const n = [...rs];
          n[i] = { ...n[i], run_id: e.run_id };
          return n;
        });
      } else if (e.type === "file-changed" && e.path === fileRef.current?.path) {
        setExternal({ hash: e.hash });
      } else if (e.type === "comments-changed" && e.path === fileRef.current?.path) {
        reloadComments();
      }
    };
    return () => es.close();
  }, [reloadComments]);

  const save = useCallback(async () => {
    const f = fileRef.current;
    if (!f || !ed.current) return true;
    try {
      const r = await api.save(f.path, ed.current.getText(), f.hash);
      setFile({ path: r.path, hash: r.hash });
      setDirty(false);
      setSaveMsg(`Saved ${new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`);
      dirtyRef.current = false;
      return true;
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409) setExternal({ hash: "" });
      setSaveMsg(`Not saved: ${err.message}`);
      return false;
    }
  }, []);

  // Autosave after 20 seconds idle.
  const typingTimer = useRef<number | undefined>(undefined);
  const autoTimer = useRef<number | undefined>(undefined);
  const addImage = async (f: File, at?: number) => {
    if (!file) return;
    try {
      const name = f.name && f.name !== "image.png" ? f.name : `pasted-${new Date().toISOString().slice(0, 10)}.png`;
      const r = await api.addImage(file.path, f, name);
      const words = name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
      const alt = /^(image|pasted|screenshot|screen shot|img|untitled)\b/i.test(words) ? "Describe the image" : words;
      ed.current?.insertImage(r.rel, alt, at);
    } catch (e) {
      setError(`Image not added: ${(e as Error).message}`);
    }
  };

  const onChange = useCallback((t: string) => {
    setDirty(true);
    window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      setWords(wordCount(t));
      setLocalStale(ed.current?.locallyStale() ?? new Set());
    }, 400);
    window.clearTimeout(autoTimer.current);
    autoTimer.current = window.setTimeout(save, AUTOSAVE_MS);
    if (jevOnRef.current) {
      window.clearTimeout(jevTimer.current);
      jevTimer.current = window.setTimeout(() => jevScoreNow(), 3000);
    }
  }, [save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // Marks shown in the editor: none in Draft mode; one perspective on its tab; all on Overview.
  const visible = useMemo(() => {
    if (mode === "draft") return [];
    const base = tab !== "overview" && tab !== "context" ? sidecar.comments.filter((c) => c.perspective === tab) : sidecar.comments;
    return applyFilters(base, { ...filters, status: filters.status === "all" ? "all" : "open" }, localStale).filter((c) => c.anchor);
  }, [sidecar, tab, filters, mode, localStale]);

  useEffect(() => {
    if (!ed.current) return;
    const marks: MarkComment[] = visible.map((c) => ({
      id: c.id, from: c.anchor!.start, to: c.anchor!.end, colour: pOf(c.perspective)?.colour ?? "#888",
      block: BLOCK_LEVELS.has(c.level), title: c.title, hint: c.hint, perspective: c.perspective, stale: c.stale, dashed: c.engine === "jev",
    }));
    ed.current.setMarks(marks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, perspectives]);

  const selectComment = useCallback((c: Comment) => {
    setActiveId(c.id);
    if (tab !== c.perspective) setTab(c.perspective);
    if (c.anchor) ed.current?.setActive(c.id);
    setTimeout(() => document.getElementById(`card-${c.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
  }, [tab]);

  const selectById = useCallback((id: string) => {
    const c = sidecar.comments.find((x) => x.id === id);
    if (c) selectComment(c);
  }, [sidecar, selectComment]);

  const p = pOf(tab);
  const scope: Scope = p ? scopes[p.id] ?? p.default_scope : "document";
  const engine: EngineName = p ? engines[p.id] ?? (p.engine === "lint" ? "lint" : p.engine) : "claude";

  // Token estimate, debounced.
  useEffect(() => {
    if (!p || !file) return;
    setEstimate(null);
    const t = window.setTimeout(() => {
      const s = ed.current?.getSelection() ?? { from: 0, to: 0 };
      api.estimate({ perspective: p.id, scope, text: text(), from: s.from, to: s.to }).then((r) => setEstimate(r.tokens)).catch(() => setEstimate(null));
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, scope, file?.path, selection]);

  const run = useCallback(async (pid: string, sc: Scope, eng: EngineName, from?: number, to?: number) => {
    const f = fileRef.current;
    const pm = pOf(pid);
    if (!f || !ed.current || !pm) return;
    const sel = ed.current.getSelection();
    const key = `${pid}-${Date.now()}`;
    setRunning((rs) => [...rs, { key, perspective: pid, engine: pm.engine === "lint" ? "lint" : eng, scope: sc, started: Date.now() }]);
    setLastMessage((m) => ({ ...m, [pid]: "" }));
    try {
      const r = await api.run({ path: f.path, perspective: pid, scope: sc, engine: eng, from: from ?? sel.from, to: to ?? sel.to, text: ed.current.getText() });
      const extra = r.dropped ? ` (${r.dropped} dropped: quote not found or guardrail)` : "";
      setLastMessage((m) => ({ ...m, [pid]: r.ok ? `${r.message.replace(/, \d+ dropped$/, "")}${extra}` : r.message }));
      await reloadComments();
      refreshState();
    } catch (e) {
      setLastMessage((m) => ({ ...m, [pid]: (e as Error).message }));
    } finally {
      setRunning((rs) => rs.filter((x) => x.key !== key));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perspectives, reloadComments, refreshState]);

  const runCurrent = () => p && run(p.id, scope, engine);
  const usualSet = () => {
    for (const id of ["lint", "argument", "evidence"]) {
      const pm = pOf(id);
      if (pm) run(id, "document", engines[id] ?? (pm.engine === "lint" ? "lint" : pm.engine));
    }
  };

  const onStatus = async (c: Comment, status: Comment["status"], reason?: string | null) => {
    const f = fileRef.current;
    if (!f) return;
    setSidecar(await api.updateComment(f.path, text(), c.id, { status, dismiss_reason: reason ?? null }));
  };

  const onRecheck = (c: Comment) => {
    const pm = pOf(c.perspective);
    if (!pm) return;
    const pos = ed.current?.positionOf(c.id);
    const at = pos?.from ?? c.anchor?.start ?? 0;
    run(pm.id, recheckScope(pm), engines[pm.id] ?? (pm.engine === "lint" ? "lint" : pm.engine), at, at);
  };

  const onExample = async (c: Comment) => {
    const f = fileRef.current;
    if (!f) return;
    setLastMessage((m) => ({ ...m, [c.perspective]: "Writing an example on another topic…" }));
    const r = await api.run({ path: f.path, perspective: c.perspective, scope: "none", text: text(), mode: "example", comment_id: c.id, engine: engines[c.perspective] });
    setLastMessage((m) => ({ ...m, [c.perspective]: r.message }));
    await reloadComments();
  };

  const openLink = async (target: string) => {
    if (/^https?:\/\//.test(target)) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      setDrawer(await api.workspaceFile(target));
    } catch (e) {
      setError(`Cannot open ${target}: ${(e as Error).message}`);
    }
  };

  // Keyboard: Ctrl-Shift-0…8 run a perspective; Ctrl-Shift-P paragraph run; Ctrl-] next comment;
  // Ctrl-Shift-D Draft/Review; Cmd-S save; Cmd-O open. (Cmd-Shift-digits are macOS screenshot keys.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "s") {
        e.preventDefault();
        save();
      } else if (e.metaKey && e.key === "o") {
        e.preventDefault();
        setDialog(true);
      } else if (e.ctrlKey && e.shiftKey && /^Digit[0-8]$/.test(e.code)) {
        e.preventDefault();
        const pm = perspectives.find((x) => x.shortcut === Number(e.code.slice(5)));
        if (pm) {
          setTab(pm.id);
          run(pm.id, scopes[pm.id] ?? pm.default_scope, engines[pm.id] ?? (pm.engine === "lint" ? "lint" : pm.engine));
        }
      } else if (e.ctrlKey && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        if (p?.scopes.includes("paragraph")) run(p.id, "paragraph", engine);
      } else if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        setMode((m) => (m === "draft" ? "review" : "draft"));
      } else if (e.ctrlKey && e.key === "]") {
        e.preventDefault();
        const list = [...visible].sort(byDocumentOrder);
        if (!list.length) return;
        const i = list.findIndex((c) => c.id === activeId);
        selectComment(list[(i + 1) % list.length]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [perspectives, scopes, engines, run, p, engine, visible, activeId, selectComment, save]);

  async function refreshJev() {
    const f = fileRef.current;
    if (!f) return;
    const js = await api.jevStatus(f.path).catch(() => null);
    setJevStatus(js);
    jevOnRef.current = !!js && js.enabled && !js.reason;
  }

  async function jevScoreNow() {
    const f = fileRef.current;
    if (!f || !ed.current || !jevOnRef.current) return;
    setJevBusy(true);
    try {
      const r = await api.jevScore(f.path, ed.current.getText());
      setJevLast(r.reason ?? r.error ?? `${r.paragraphs} prose paragraphs: ${r.flagged} signal${r.flagged === 1 ? "" : "s"} (${r.scored} checked, ${r.cached} unchanged)${r.skipped_budget ? `, ${r.skipped_budget} skipped: daily limit` : ""}.`);
      await reloadComments();
    } catch (e) {
      setJevLast((e as Error).message);
    } finally {
      setJevBusy(false);
      refreshJev();
    }
  }

  async function refreshCite() {
    const f = fileRef.current;
    if (!f) return;
    setCiteStatus(await api.citeStatus(f.path, text()).catch(() => null));
  }
  useEffect(() => {
    if (tab === "citations") refreshCite();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, file?.path]);

  const noteWarnings = (r: { unreferenced: string[]; nested: string[]; repeated: string[]; adopted: number }) =>
    [
      r.adopted ? `${r.adopted} plain note label${r.adopted === 1 ? "" : "s"} given FN numbers` : "",
      r.unreferenced.length ? `not referenced in the text: ${r.unreferenced.join(", ")}` : "",
      r.nested.length ? `referenced only inside another note (Word cannot show these): ${r.nested.join(", ")}` : "",
      r.repeated.length ? `referenced more than once: ${r.repeated.join(", ")}` : "",
    ].filter(Boolean).join("; ");

  const citeControls = {
    status: citeStatus, busy: citeBusy, message: citeMsg,
    onStyle: async (s: string) => {
      const f = fileRef.current;
      if (!f) return;
      await api.citeStyle(f.path, s);
      refreshCite();
    },
    onRenumber: () => {
      const r = renumberNotes(text(), { adoptPlain: true });
      if (r.error) return setCiteMsg(r.error);
      if (r.changed) ed.current?.applyText(r.text);
      const w = noteWarnings(r);
      setCiteMsg(`${r.changed ? "Renumbered in reading order (Cmd-Z undoes)." : "Already in reading order."}${w ? ` Note: ${w}.` : ""}`);
      setTimeout(refreshCite, 50);
    },
    onConvert: (from: "FN" | "EN", to: "FN" | "EN") => {
      const r = convertNotes(text(), from, to);
      if (r.error) return setCiteMsg(r.error);
      if (r.changed) ed.current?.applyText(r.text);
      setCiteMsg(`${from === "FN" ? "Footnotes" : "Endnotes"} converted to ${to === "FN" ? "footnotes" : "endnotes"} and renumbered (Cmd-Z undoes).`);
      setTimeout(refreshCite, 50);
    },
    onCheck: async () => {
      const f = fileRef.current;
      if (!f) return;
      setCiteBusy("Fetching sources and checking quotes…");
      try {
        const r = await api.citeCheck(f.path, text());
        setCiteMsg(r.quotes ? `${r.quotes} quote${r.quotes === 1 ? "" : "s"}: ${r.exact} word for word, ${r.close} close, ${r.not_found} not found, ${r.not_checked} not checked.` : "No quotations of four or more words found.");
        await reloadComments();
      } catch (e) {
        setCiteMsg((e as Error).message);
      } finally {
        setCiteBusy("");
        refreshCite();
      }
    },
    onFormat: async () => {
      const f = fileRef.current;
      const style = citeStatus?.style;
      if (!f || !style) return;
      setCiteBusy("Reading the notes with Claude and formatting them (about a minute)…");
      try {
        setCitePreview(await api.citeFormat(f.path, text(), style));
        setCiteMsg("");
      } catch (e) {
        setCiteMsg((e as Error).message);
      } finally {
        setCiteBusy("");
      }
    },
    onValidate: async () => {
      const f = fileRef.current;
      if (!f) return;
      setCiteBusy("Validating references: looking up each source, fetching full texts and checking each claim with Claude (a few minutes)…");
      try {
        const r = await api.citeValidate(f.path, text());
        setCiteMsg(`${r.sources} source${r.sources === 1 ? "" : "s"} in ${r.notes} notes checked: ${r.problems} to look at (see the cards and the list below).`);
        await reloadComments();
      } catch (e) {
        setCiteMsg((e as Error).message);
      } finally {
        setCiteBusy("");
        refreshCite();
      }
    },
    onLink: async (label: string, file: File) => {
      const f = fileRef.current;
      if (!f) return;
      setCiteBusy(`Linking ${file.name}…`);
      try {
        const r = await api.citeLink(f.path, label, file);
        setCiteMsg(`Linked ${file.name} (${r.words.toLocaleString()} words) to ${label.replace(/-[a-z0-9]+$/, "")}, saved in the reference library. Run Check quotes to use it.`);
      } catch (e) {
        setCiteMsg((e as Error).message);
      } finally {
        setCiteBusy("");
        refreshCite();
      }
    },
  };

  const jevControls = {
    status: jevStatus, busy: jevBusy, last: jevLast,
    onEnable: async () => {
      const f = fileRef.current;
      if (!f) return;
      await api.jevEnable(f.path);
      await refreshJev();
      jevScoreNow();
    },
    onDisable: async () => {
      const f = fileRef.current;
      if (!f) return;
      jevOnRef.current = false;
      window.clearTimeout(jevTimer.current);
      await api.jevDisable(f.path, text());
      setJevLast("");
      await refreshJev();
      await reloadComments();
    },
    onRescore: () => jevScoreNow(),
  };

  const quit = async () => {
    if (running.length && !confirm(`${running.length} review${running.length === 1 ? " is" : "s are"} still running. Quit anyway and cancel ${running.length === 1 ? "it" : "them"}?`)) return;
    if (dirtyRef.current && !(await save()) && !confirm("Saving failed. Quit and lose the unsaved changes?")) return;
    dirtyRef.current = false;
    try {
      await api.quit();
    } catch {
      /* already stopping */
    }
    setClosed(true);
    document.title = "Draftroom (closed)";
  };

  const resolveExternal = async (reload: boolean) => {
    const f = fileRef.current;
    if (!f) return;
    if (reload) {
      dirtyRef.current = false;
      await openPath(f.path);
    } else {
      // Keep mine: the next save overwrites the disk version.
      const r = await api.open(f.path);
      setFile({ path: f.path, hash: r.hash });
      setExternal(null);
      setDirty(true);
    }
  };

  if (closed) {
    return (
      <div className="welcome">
        <h1>Draftroom has closed</h1>
        <p className="muted">Your work is saved. You can close this tab. Run <code>draftroom</code> to start again.</p>
      </div>
    );
  }

  return (
    <div className={`app mode-${mode}`}>
      <header className="top">
        <button onClick={() => setNewDir(st?.new_drafts_dir ?? st?.drafts_root ?? "")}>New</button>
        <button onClick={() => setDialog(true)} title="Cmd-O">Open</button>
        <button onClick={() => setImportDir(file ? file.path.split("/").slice(0, -1).join("/") : st?.new_drafts_dir ?? st?.drafts_root ?? "")}>Import Word…</button>
        <button disabled={!file} onClick={() => setExporting(true)}>Export Word…</button>
        <span className="filename" title={file?.path}>{file ? file.path.split("/").slice(-2).join("/") : "No draft open"}</span>
        <span className="muted small">{words.toLocaleString()} words{ctx.context.length_target ? ` of ${ctx.context.length_target}` : ""}</span>
        <span className="muted small">{dirty ? "Unsaved" : saveMsg}</span>
        <span className="spacer" />
        <button className="link" onClick={() => ed.current?.togglePrep()}>Prep</button>
        <div className="seg" role="group" aria-label="Mode" title="Ctrl-Shift-D">
          <button className={mode === "draft" ? "on" : ""} onClick={() => setMode("draft")}>Draft</button>
          <button className={mode === "review" ? "on" : ""} onClick={() => setMode("review")}>Review</button>
        </div>
        <button onClick={quit} title="Save and close Draftroom">Quit</button>
      </header>
      {external && (
        <div className="banner">
          The file changed on disk outside Draftroom.
          <button onClick={() => resolveExternal(true)}>Reload (lose unsaved)</button>
          <button onClick={() => resolveExternal(false)}>Keep mine</button>
        </div>
      )}
      {st?.profile_warnings?.length ? <div className="banner">{st.profile_warnings.join(" ")}</div> : null}
      {error && (
        <div className="banner banner-error" onClick={() => setError("")}>{error} <span className="muted">(click to dismiss)</span></div>
      )}
      <main className="main">
        <section className="editor-pane">
          {initial !== null && <Toolbar state={fmt} onCommand={(c) => ed.current?.format(c)} onImage={(f) => addImage(f)} />}
          {initial !== null ? (
            <Editor ref={ed} initial={initial} onChange={onChange} onSelectComment={selectById} onFormat={setFmt} onImageFile={(f, at) => addImage(f, at)}
              onCursor={() => {
                const s = ed.current?.getSelection();
                setSelection(!!s && s.to > s.from);
              }} />
          ) : (
            <div className="welcome">
              <h1>Draftroom</h1>
              <p className="muted">Nothing open.</p>
              <div className="welcome-actions">
                <button className="primary" onClick={() => setNewDir(st?.new_drafts_dir ?? st?.drafts_root ?? "")}>New draft</button>
                <button onClick={() => setDialog(true)}>Open…</button>
                <button onClick={() => setImportDir(st?.new_drafts_dir ?? st?.drafts_root ?? "")}>Import Word…</button>
              </div>
            </div>
          )}
        </section>
        {!file ? null : mode === "review" ? (
          <Panel
            tab={tab} onTab={setTab} perspectives={perspectives} sidecar={sidecar} localStale={localStale}
            detail={detail} onDetail={setDetail} filters={filters} onFilters={setFilters}
            activeId={activeId} onSelect={selectComment}
            scope={scope} engine={engine} estimate={estimate} running={running} hasSelection={selection}
            onScope={(s) => p && setScopes((m) => ({ ...m, [p.id]: s }))}
            onEngine={(e) => p && setEngines((m) => ({ ...m, [p.id]: e }))}
            onRun={runCurrent}
            onCancel={(r) => r.run_id && api.cancel(r.run_id)}
            onStatus={onStatus} onRecheck={onRecheck} onExample={onExample} onOpenLink={openLink} onUsualSet={usualSet}
            usage={st?.usage ?? {}} examplesPerDay={st?.examples_per_day ?? 10}
            context={ctx.context} contextSaved={ctx.saved} voices={st?.voices ?? []}
            onSaveContext={async (c) => {
              if (!file) return;
              await api.saveContext(file.path, c);
              setCtx({ context: c, saved: true });
            }}
            lastMessage={lastMessage}
            jev={jevControls}
            cite={citeControls}
          />
        ) : (
          <aside className="rail" onClick={() => setMode("review")} title="Show the advice panel">
            {sidecar.comments.filter((c) => c.status === "open").length} open
          </aside>
        )}
      </main>
      {drawer && <Drawer path={drawer.path} content={drawer.content} onClose={() => setDrawer(null)} />}
      {dialog && <FileDialog start={file ? file.path.split("/").slice(0, -1).join("/") : undefined} onOpen={openPath} onClose={() => setDialog(false)} onImport={(dir) => { setDialog(false); setImportDir(dir); }} onNew={(dir) => { setDialog(false); setNewDir(dir); }} />}
      {newDir !== null && <NewDialog dir={newDir} onClose={() => setNewDir(null)} onDone={(p) => { setNewDir(null); openPath(p); }} />}
      {citePreview && (
        <CitePreview preview={citePreview} onClose={() => setCitePreview(null)} onAccept={async (labels) => {
          const f = fileRef.current;
          if (!f || !ed.current) return;
          const current = ed.current.getText();
          const now = new Map(parseNotes(current).defs.map((d) => [d.label, d.body]));
          const bodies: Record<string, string> = {};
          const changedSince: string[] = [];
          for (const e of citePreview.entries) {
            if (!labels.includes(e.label)) continue;
            if (now.get(e.label) === e.before) bodies[e.label] = e.after;
            else changedSince.push(e.label.replace(/-[a-z0-9]+$/, ""));
          }
          const next = replaceDefinitionBodies(current, bodies);
          ed.current.applyText(next);
          await api.citeAccepted(f.path, next, citePreview.style).catch(() => undefined);
          setCiteMsg(`${Object.keys(bodies).length} note${Object.keys(bodies).length === 1 ? "" : "s"} formatted (Cmd-Z undoes).${changedSince.length ? ` Skipped because you edited them after the preview: ${changedSince.join(", ")}.` : ""}`);
          setCitePreview(null);
          refreshCite();
        }} />
      )}
      {importDir !== null && <ImportDialog dir={importDir} onClose={() => setImportDir(null)} onDone={(p) => { setImportDir(null); openPath(p); }} />}
      {exporting && file && <ExportDialog path={file.path} hasBody={text().includes("<!-- body -->")} getText={text} onClose={() => setExporting(false)} />}
    </div>
  );
}
