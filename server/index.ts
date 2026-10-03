// Draftroom server. Binds 127.0.0.1 only. Security model copied from the workspace dashboard
// (scripts/README-daily-dashboard.md): bootstrap token sets an HttpOnly SameSite=Strict cookie,
// every request needs it, Host is allowlisted, and every non-GET request needs an allowlisted Origin.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { loadProfile, readPathAllowed, REPO, profileWarnings, DEFAULT_VOICES } from "./profile.ts";
import { openFile, saveFile, browse, FileError, acceptDisk, createDraft, closeWatcher, insideProgram, saveDraftImage } from "./files.ts";
import { loadComments, updateComment } from "./store.ts";
import { loadContext, saveContext, configureContext } from "./context.ts";
import { loadPerspectives } from "./perspectives.ts";
import { startRun, cancelRun, cancelAll, events, estimateTokens, initHome, usageToday, EXAMPLES_PER_DAY } from "./runs.ts";
import { activeRuns, MAX_CONCURRENT } from "./engines/pool.ts";
import { importToFolder, exportFromDraft, listTemplates, defaultExportPath, ExistsError } from "./docx/service.ts";
import { draftPathAllowed, realLoose } from "./profile.ts";
import { pandocVersion, runPandoc } from "./docx/pandoc.ts";
import { touchRecent, listRecent } from "./recent.ts";
import { scorePass, setJevEnabled, recordJevOutcome, gateReason, loadJevConfig, questionStatus, jevUsageToday, CONSENT_TEXT, configureJev } from "./jev/signals.ts";
import { readJevState } from "./jev/state.ts";
import { writeSidecar } from "./store.ts";
import { checkQuotes, linkFile } from "./cite/check.ts";
import { formatPreview, recordAccepted, orderKey } from "./cite/preview.ts";
import { validateReferences } from "./cite/verify.ts";
import { readCiteState, writeCiteState, suffixOf } from "./cite/state.ts";
import { parseNotes } from "../shared/notes.ts";
import { noteUrl } from "./cite/quotes.ts";
import { deniedDomain, DEFAULT_DENIED_DOMAINS } from "./cite/fetch.ts";
import os from "node:os";
import type { RunEvent, RunRequest } from "../shared/types.ts";

const args = process.argv.slice(2);
const DEV = args.includes("--dev");
const PORT = Number(process.env.DRAFTROOM_PORT ?? 8790);
const openArg = args.includes("--open") ? args[args.indexOf("--open") + 1] : undefined;
const NO_BROWSER = args.includes("--no-browser") || DEV;

const TOKEN = crypto.randomBytes(24).toString("hex");
const COOKIE = "draftroom";
const ports = DEV ? [PORT, 5173] : [PORT];
const HOSTS = new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
const ORIGINS = new Set(ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));
const DIST = path.join(REPO, "client", "dist");
const MAX_BODY = 8 * 1024 * 1024;
const MAX_UPLOAD = 200 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp" };
const PUBLIC_ICONS = new Set(["/favicon.ico", "/favicon.svg", "/favicon-32.png", "/favicon-64.png", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]);
const exported = new Set<string>(); // files this session wrote by Export, the only ones Show in Finder reveals

const prof = loadProfile();
configureContext(prof.publications);
configureJev(prof.jev_extra_questions);
initHome();
let currentFile: string | null = null;

const sse = new Set<http.ServerResponse>();

// Stop by itself once no Draftroom tab has been open for a while and nothing is running,
// so closing the tab never leaves a stray server. 0 turns it off.
const IDLE_MINUTES = DEV ? 0 : Number(process.env.DRAFTROOM_IDLE_MINUTES ?? 15);
let idleTimer: NodeJS.Timeout | null = null;
function armIdle() {
  if (!IDLE_MINUTES || idleTimer || sse.size) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (sse.size) return;
    if (activeRuns()) return armIdle();
    shutdown(`no Draftroom tab open for ${IDLE_MINUTES} minutes`);
  }, IDLE_MINUTES * 60_000);
}
function disarmIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}
let stopping = false;
function shutdown(why: string) {
  if (stopping) return;
  stopping = true;
  console.log(`Draftroom stopped: ${why}.`);
  cancelAll();
  for (const r of sse) r.end();
  void closeWatcher();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on("SIGINT", () => shutdown("interrupted"));
process.on("SIGTERM", () => shutdown("terminated"));
function broadcast(e: RunEvent) {
  const data = `data: ${JSON.stringify(e)}\n\n`;
  for (const r of sse) r.write(data);
}
events.on("event", broadcast);

function onExternalChange(p: string, hash: string) {
  broadcast({ type: "file-changed", path: p, hash });
}

function cookieOk(req: http.IncomingMessage): boolean {
  const c = req.headers.cookie ?? "";
  return c.split(/;\s*/).some((kv) => {
    const [k, v] = kv.split("=");
    return k === COOKIE && v !== undefined && v.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(TOKEN));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

async function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new FileError("upload too large", 413);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new FileError("request too large", 413);
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2",
  ".png": "image/png", ".ico": "image/x-icon",
};

function serveStatic(res: http.ServerResponse, urlPath: string) {
  if (urlPath === "/apple-touch-icon-precomposed.png") urlPath = "/apple-touch-icon.png";
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(DIST, "index.html");
    if (!fs.existsSync(index)) return send(res, 503, { error: "client not built: run npm run build" });
    res.writeHead(200, { "content-type": MIME[".html"] });
    return res.end(fs.readFileSync(index));
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? "";
    if (!HOSTS.has(host)) return send(res, 403, { error: "host not allowed" });
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (url.pathname === "/api/bootstrap") {
      const k = url.searchParams.get("k") ?? "";
      if (k.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(TOKEN))) return send(res, 403, { error: "bad token" });
      res.writeHead(302, { "set-cookie": `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`, location: "/" });
      return res.end();
    }
    // Tab icons: browsers (Safari especially) fetch these without the session cookie. They are public and harmless.
    if (req.method === "GET" && PUBLIC_ICONS.has(url.pathname)) return serveStatic(res, url.pathname);
    if (!cookieOk(req)) return send(res, 403, { error: "open Draftroom from the URL printed in the terminal" });
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (!origin || !ORIGINS.has(origin)) return send(res, 403, { error: "origin not allowed" });
    }
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/state": {
        // Lint needs a tell-lint script in the profile; without one its tab is hidden.
        const ps = loadPerspectives().filter((x) => x.id !== "lint" || prof.tell_lint).map(({ body, ...meta }) => meta);
        return send(res, 200, { file: currentFile, perspectives: ps, voices: prof.voices ?? DEFAULT_VOICES, usage: usageToday(), active: activeRuns(), max_concurrent: MAX_CONCURRENT, examples_per_day: EXAMPLES_PER_DAY, profile: prof.name, drafts_root: prof.drafts_root, workspace: prof.workspace, new_drafts_dir: prof.new_drafts_dir ?? prof.drafts_root, profile_warnings: profileWarnings(prof) });
      }
      case "GET /api/events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": ok\n\n");
        sse.add(res);
        disarmIdle();
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          sse.delete(res);
          armIdle();
        });
        return;
      }
      case "GET /api/file": {
        const p = url.searchParams.get("path");
        if (!p) return send(res, 400, { error: "path required" });
        const f = openFile(prof, p, onExternalChange);
        currentFile = f.path;
        touchRecent(f.path, "opened");
        return send(res, 200, f);
      }
      case "PUT /api/file": {
        const b = await readBody(req);
        const saved = saveFile(prof, String(b.path), String(b.content), String(b.base_hash));
        touchRecent(saved.path, "edited");
        return send(res, 200, saved);
      }
      case "POST /api/file/accept-disk": {
        const b = await readBody(req);
        acceptDisk(String(b.path), String(b.hash));
        return send(res, 200, { ok: true });
      }
      case "POST /api/new": {
        const b = await readBody(req);
        const p = createDraft(prof, String(b.dir ?? ""), String(b.name ?? ""), String(b.title ?? ""));
        touchRecent(p, "created");
        return send(res, 200, { path: p });
      }
      case "GET /api/recent": {
        return send(res, 200, { recent: listRecent(prof) });
      }
      case "GET /api/browse": {
        return send(res, 200, browse(prof, url.searchParams.get("dir") ?? prof.drafts_root));
      }
      case "POST /api/comments/load": {
        const b = await readBody(req);
        return send(res, 200, loadComments(guardDraft(b.path), String(b.text)));
      }
      case "POST /api/comments/update": {
        const b = await readBody(req);
        const patch: Record<string, unknown> = {};
        if (["open", "resolved", "dismissed"].includes(b.patch?.status)) patch.status = b.patch.status;
        if (typeof b.patch?.dismiss_reason === "string" || b.patch?.dismiss_reason === null) patch.dismiss_reason = b.patch.dismiss_reason;
        if (typeof b.patch?.stale === "boolean") patch.stale = b.patch.stale;
        const draftForUpdate = guardDraft(b.path);
        if (String(b.id).startsWith("jev-") && typeof patch.status === "string") {
          // the writer's outcome on a Jev flag: keeps it quiet and feeds the question's precision.
          recordJevOutcome(draftForUpdate, String(b.id), patch.status === "resolved" ? "resolved" : patch.status === "dismissed" ? ((patch.dismiss_reason as any) ?? "disagree") : null);
        }
        return send(res, 200, updateComment(draftForUpdate, String(b.text), String(b.id), patch));
      }
      case "POST /api/context/load": {
        const b = await readBody(req);
        return send(res, 200, loadContext(guardDraft(b.path), String(b.text)));
      }
      case "PUT /api/context": {
        const b = await readBody(req);
        const ctx = b.context ?? {};
        // Reference folders are handed to model runs: check each against the policy now.
        for (const d of ctx.reference_folders ?? []) {
          const ok = readPathAllowed(prof, String(d), [path.dirname(guardDraft(b.path))]);
          if (!ok.ok) return send(res, 400, { error: `reference folder ${d}: ${ok.why}` });
        }
        saveContext(guardDraft(b.path), ctx);
        return send(res, 200, { ok: true });
      }
      case "POST /api/estimate": {
        const b = await readBody(req);
        const p = loadPerspectives().find((x) => x.id === b.perspective);
        if (!p) return send(res, 400, { error: "unknown perspective" });
        return send(res, 200, { tokens: estimateTokens(prof, p, String(b.text), b.scope, b.from, b.to) });
      }
      case "POST /api/run": {
        const b = (await readBody(req)) as RunRequest;
        b.path = guardDraft(b.path);
        return send(res, 200, await startRun(prof, b));
      }
      case "GET /api/jev/status": {
        const p = url.searchParams.get("path");
        const cfg = loadJevConfig();
        const today = jevUsageToday();
        const base = {
          version: cfg.version, questions_total: cfg.questions.length, today: { ...today, cost_usd: (today.tokens / 1e6) * cfg.price_per_million_input },
          consent_text: CONSENT_TEXT,
        };
        if (!p || p !== currentFile) return send(res, 200, { ...base, enabled: false, reason: "No draft open" });
        const text = fs.readFileSync(p, "utf8");
        const st = readJevState(p);
        const reason = gateReason(prof, p, text, st);
        return send(res, 200, { ...base, enabled: st.enabled, consented: !!st.consent, reason, model: st.last_model ?? null, questions: questionStatus(cfg, st) });
      }
      case "POST /api/jev/enable": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        setJevEnabled(p, true, CONSENT_TEXT);
        return send(res, 200, { ok: true });
      }
      case "POST /api/jev/disable": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        setJevEnabled(p, false);
        const sc = loadComments(p, String(b.text ?? fs.readFileSync(p, "utf8")));
        sc.comments = sc.comments.filter((c) => c.engine !== "jev");
        delete sc.summaries.jev;
        writeSidecar(p, sc);
        broadcast({ type: "comments-changed", path: p });
        return send(res, 200, { ok: true });
      }
      case "POST /api/jev/score": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        const r = await scorePass(prof, p, String(b.text));
        if (r.ok || r.flagged || r.scored) broadcast({ type: "comments-changed", path: p });
        return send(res, 200, r);
      }
      case "POST /api/cite/status": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        const text = String(b.text);
        const st = readCiteState(p);
        const { refs, defs } = parseNotes(text);
        const denied = prof.cite_denied_domains ?? DEFAULT_DENIED_DOMAINS;
        const notes = defs.map((d) => {
          const url = noteUrl(d.body);
          const suf = suffixOf(d.label);
          const quotes = st.quotes.filter((q) => q.label && suffixOf(q.label) === suf);
          let host: string | null = null;
          try { host = url ? new URL(url).hostname.replace(/^www\./, "") : null; } catch { host = null; }
          return {
            label: d.label, body: d.body.slice(0, 220), url, host,
            lead_only: host ? !!deniedDomain(host, denied) : false,
            linked: st.links[suf] ?? null, fetched: st.sources[suf] ?? null,
            refs: refs.filter((r) => r.label === d.label && !r.inDefinition).length,
            quotes: quotes.map((q) => ({ quote: q.quote, status: q.status, detail: q.detail })),
            validation: (st.validation as any)?.[suf] ?? null,
          };
        });
        const positions_stale = !!st.formatted && st.formatted.order_key !== orderKey(text);
        return send(res, 200, { style: st.style, notes, checked_at: st.quotes[0]?.checked_at ?? null, formatted: st.formatted ?? null, positions_stale });
      }
      case "POST /api/cite/check-quotes": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        const r = await checkQuotes(prof, p, String(b.text));
        broadcast({ type: "comments-changed", path: p });
        return send(res, 200, r);
      }
      case "POST /api/image": {
        const p = guardDraft(url.searchParams.get("path"));
        const bytes = await readRaw(req, 25 * 1024 * 1024);
        return send(res, 200, saveDraftImage(p, url.searchParams.get("name") ?? "image", bytes));
      }
      case "POST /api/cite/link": {
        const p = guardDraft(url.searchParams.get("path"));
        const label = url.searchParams.get("label") ?? "";
        const name = (url.searchParams.get("name") ?? "file").replace(/[\\/]/g, "_");
        if (!/^(FN|EN)\d+-[a-z0-9]+$/.test(label) && !/^[^\]\s]+$/.test(label)) return send(res, 400, { error: "bad note label" });
        const bytes = await readRaw(req, 100 * 1024 * 1024);
        const r = await linkFile(prof, p, label, name, bytes);
        return send(res, 200, r);
      }
      case "POST /api/cite/format": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        if (!["aglc4", "chicago18"].includes(b.style)) return send(res, 400, { error: "Formatting supports AGLC 4 and Chicago 18 so far; APA comes in a later release." });
        return send(res, 200, await formatPreview(prof, p, String(b.text), b.style));
      }
      case "POST /api/cite/validate": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        const r = await validateReferences(prof, p, String(b.text), Array.isArray(b.labels) ? b.labels.map(String) : undefined);
        broadcast({ type: "comments-changed", path: p });
        return send(res, 200, r);
      }
      case "POST /api/cite/accepted": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        recordAccepted(p, String(b.style), orderKey(String(b.text)));
        return send(res, 200, { ok: true });
      }
      case "POST /api/cite/style": {
        const b = await readBody(req);
        const p = guardDraft(b.path);
        const st = readCiteState(p);
        st.style = ["aglc4", "chicago18", "apa7"].includes(b.style) ? b.style : null;
        writeCiteState(p, st);
        return send(res, 200, { style: st.style });
      }
      case "POST /api/quit": {
        send(res, 200, { ok: true });
        setTimeout(() => shutdown("Quit pressed"), 100);
        return;
      }
      case "POST /api/run/cancel": {
        const b = await readBody(req);
        return send(res, 200, { cancelled: cancelRun(String(b.run_id)) });
      }
      case "GET /api/templates": {
        let pandoc = "";
        try {
          pandoc = await pandocVersion();
        } catch (e) {
          pandoc = `missing: ${(e as Error).message}`;
        }
        return send(res, 200, { templates: listTemplates().map(({ id, label }) => ({ id, label })), pandoc });
      }
      case "POST /api/import": {
        // Raw .docx bytes; ?dir= target folder, ?name= original file name.
        const dir = url.searchParams.get("dir") ?? "";
        const name = (url.searchParams.get("name") ?? "imported.docx").replace(/[\/]/g, "_");
        if (!/\.docx$/i.test(name)) return send(res, 400, { error: "choose a .docx file" });
        if (!path.isAbsolute(dir)) return send(res, 400, { error: "folder must be an absolute path" });
        const ok = draftPathAllowed(prof, path.join(dir, "probe.md"));
        if (!ok.ok) return send(res, 403, { error: `cannot import into ${dir}: ${ok.why}` });
        if (insideProgram(dir)) return send(res, 403, { error: "That is Draftroom's program folder: choose a writing folder (for example outputs/drafts)" });
        const bytes = await readRaw(req, MAX_UPLOAD);
        if (bytes.subarray(0, 2).toString() !== "PK") return send(res, 400, { error: "not a Word .docx file" });
        const tmpDir = path.join(process.env.DRAFTROOM_HOME ?? path.join(os.homedir(), ".draftroom"), "tmp");
        fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
        const tmp = path.join(tmpDir, `${crypto.randomBytes(6).toString("hex")}-${name}`);
        fs.writeFileSync(tmp, bytes, { mode: 0o600 });
        try {
          const out = await importToFolder(tmp, path.dirname(ok.real!), { name, home: process.env.DRAFTROOM_HOME });
          out.report.markdownPath = out.path;
          touchRecent(out.path, "imported");
          return send(res, 200, out);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
      case "POST /api/export": {
        const b = await readBody(req);
        const draft = guardDraft(b.path);
        const out = b.out_path ? realLoose(String(b.out_path)) : defaultExportPath(draft);
        if (!/\.docx$/i.test(out)) return send(res, 400, { error: "the output must be a .docx file" });
        const okOut = draftPathAllowed(prof, out.replace(/\.docx$/i, ".md"));
        if (!okOut.ok) return send(res, 403, { error: `cannot write ${out}: ${okOut.why}` });
        let template = String(b.template ?? "report");
        if (path.isAbsolute(template)) {
          const t = readPathAllowed(prof, template, [path.dirname(draft)]);
          if (!t.ok || !/\.docx$/i.test(t.real!)) return send(res, 400, { error: `template ${template}: ${t.why ?? "must be a .docx file"}` });
          template = t.real!;
        }
        const names = Object.fromEntries(loadPerspectives().map((x) => [x.id, x.name]));
        try {
          const r = await exportFromDraft({
            draftPath: draft, text: String(b.text), outPath: out, overwrite: !!b.overwrite, template,
            scope: b.scope === "all" ? "all" : "body", titleBlock: b.title_block !== false,
            notes: ["footnotes", "endnotes"].includes(b.notes) ? b.notes : "as-labelled",
            comments: ["word", "all"].includes(b.comments) ? b.comments : "none", includeJev: b.include_jev === true, perspectiveNames: names,
          });
          exported.add(r.outPath);
          return send(res, 200, r);
        } catch (e) {
          if (e instanceof ExistsError) return send(res, 409, { error: e.message, exists: true });
          throw e;
        }
      }
      case "POST /api/reveal": {
        const b = await readBody(req);
        if (!exported.has(String(b.path))) return send(res, 403, { error: "only files exported this session" });
        execFile("open", ["-R", String(b.path)]);
        return send(res, 200, { ok: true });
      }
      case "GET /api/asset": {
        // Images beside the open draft, for the editor's inline preview.
        if (!currentFile) return send(res, 404, { error: "no draft open" });
        const rel = url.searchParams.get("rel") ?? "";
        const dir = path.dirname(currentFile);
        const p = path.resolve(dir, rel);
        const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
        if (!mime || !fs.existsSync(p)) return send(res, 404, { error: "not found" });
        const real = fs.realpathSync(p);
        if (!real.startsWith(fs.realpathSync(dir) + path.sep)) return send(res, 403, { error: "outside the draft folder" });
        res.writeHead(200, { "content-type": mime, "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
        return res.end(fs.readFileSync(real));
      }
      case "POST /api/render-grid": {
        // Grid tables (complex Word tables) rendered for the editor's preview. Raw HTML is off.
        const b = await readBody(req);
        // Note references become superscript numbers (FN01-… → 1, EN07-… → e7): the preview has no definitions.
        // Widths are kept: the token is padded to the reference's length so the grid stays aligned.
        const md = String(b.md ?? "").slice(0, 300_000).replace(/\[\^((?:FN|EN)?)0*(\d+)?[^\]\s]*\]/g, (all, kind: string, n: string) => {
          const label = `^${kind === "EN" ? "e" : ""}${n ?? "*"}^`;
          return label.padEnd(all.length, " ");
        });
        const html = await runPandoc(["-f", "markdown-raw_html-tex_math_dollars-citations-subscript", "-t", "html"], md);
        return send(res, 200, { html });
      }
      case "GET /api/workspace-file": {
        const p = url.searchParams.get("path") ?? "";
        const ok = readPathAllowed(prof, p, currentFile ? [path.dirname(currentFile)] : []);
        if (!ok.ok) return send(res, 403, { error: ok.why });
        if (fs.statSync(ok.real!).isDirectory()) return send(res, 400, { error: "a folder" });
        return send(res, 200, { path: ok.real, content: fs.readFileSync(ok.real!, "utf8").slice(0, 400_000) });
      }
      default:
        return send(res, 404, { error: "not found" });
    }
  } catch (e) {
    const status = e instanceof FileError ? e.status : 500;
    return send(res, status, { error: (e as Error).message });
  }
});

/** Comment, context and run routes act only on the draft currently open. */
function guardDraft(p: unknown): string {
  if (typeof p !== "string" || p !== currentFile) throw new FileError("not the open draft", 403);
  return p;
}

server.listen(PORT, "127.0.0.1", () => {
  const base = DEV ? "http://localhost:5173" : `http://127.0.0.1:${PORT}`;
  const url = `${base}/api/bootstrap?k=${TOKEN}`;
  if (openArg) {
    try {
      const f = openFile(prof, openArg, onExternalChange);
      currentFile = f.path;
    } catch (e) {
      console.error(`could not open ${openArg}: ${(e as Error).message}`);
    }
  }
  console.log(`Draftroom on ${base}\nOpen: ${url}`);
  if (IDLE_MINUTES) console.log(`Stops by itself after ${IDLE_MINUTES} minutes with no Draftroom tab open, or use Quit.`);
  armIdle();
  if (!NO_BROWSER) execFile("open", [url]);
});
