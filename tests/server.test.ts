// Starts the real server against a sandbox and checks the security rules from the plan.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandbox } from "./helpers.ts";
import { hashText } from "../shared/doc.ts";

const sb = sandbox();
const PORT = 8799;
let proc: ChildProcess;
let token = "";
let cookie = "";

function req(method: string, p: string, o: { body?: unknown; origin?: string | null; host?: string; cookie?: string | null } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }>((resolve, reject) => {
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${PORT}` };
    if (o.cookie !== null) headers.cookie = o.cookie ?? cookie;
    if (o.origin !== null && method !== "GET") headers.origin = o.origin ?? `http://127.0.0.1:${PORT}`;
    if (body) headers["content-type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, json: d ? (() => { try { return JSON.parse(d); } catch { return d; } })() : null }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

beforeAll(async () => {
  proc = spawn(path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsx"), ["server/index.ts", "--no-browser", "--open", sb.draft], {
    cwd: path.join(import.meta.dirname, ".."),
    env: { ...process.env, DRAFTROOM_PROFILE: sb.profPath, DRAFTROOM_PORT: String(PORT), DRAFTROOM_HOME: sb.home },
  });
  token = await new Promise<string>((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000);
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = /k=([0-9a-f]+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    proc.stderr!.on("data", (d) => (out += d));
  });
}, 20_000);

afterAll(() => {
  proc?.kill();
});

describe("server security", () => {
  it("refuses requests without the cookie", async () => {
    expect((await req("GET", "/api/state", { cookie: null })).status).toBe(403);
  });
  it("refuses a bad token and a foreign Host", async () => {
    expect((await req("GET", `/api/bootstrap?k=${"0".repeat(token.length)}`, { cookie: null })).status).toBe(403);
    expect((await req("GET", `/api/bootstrap?k=${token}`, { cookie: null, host: "evil.example:8799" })).status).toBe(403);
  });
  it("bootstrap sets an HttpOnly SameSite=Strict cookie", async () => {
    const r = await req("GET", `/api/bootstrap?k=${token}`, { cookie: null });
    expect(r.status).toBe(302);
    const sc = String(r.headers["set-cookie"]);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Strict/);
    cookie = sc.split(";")[0];
    const st = await req("GET", "/api/state");
    expect(st.status).toBe(200);
    expect(st.json.file).toBe(sb.draft);
  });
  it("PUT without an Origin is refused", async () => {
    const r = await req("PUT", "/api/file", { origin: null, body: { path: sb.draft, content: "x", base_hash: "" } });
    expect(r.status).toBe(403);
  });
  it("PUT with a foreign Origin is refused", async () => {
    const r = await req("PUT", "/api/file", { origin: "http://evil.example", body: { path: sb.draft, content: "x", base_hash: "" } });
    expect(r.status).toBe(403);
  });
  it("refuses to save a file the server did not open, a non-md file, or anything under .git", async () => {
    const other = path.join(sb.root, "posts", "other.md");
    fs.writeFileSync(other, "hi");
    expect((await req("PUT", "/api/file", { body: { path: other, content: "x", base_hash: hashText("hi") } })).status).toBe(403);
    expect((await req("PUT", "/api/file", { body: { path: path.join(sb.postDir, "notes.txt"), content: "x", base_hash: "" } })).status).toBe(403);
    fs.mkdirSync(path.join(sb.root, ".git", "hooks"), { recursive: true });
    expect((await req("PUT", "/api/file", { body: { path: path.join(sb.root, ".git", "hooks", "pre-commit.md"), content: "x", base_hash: "" } })).status).toBe(403);
  });
  it("refuses a stale save, accepts a current one", async () => {
    const text = fs.readFileSync(sb.draft, "utf8");
    expect((await req("PUT", "/api/file", { body: { path: sb.draft, content: text + "\nx", base_hash: "deadbeef:1" } })).status).toBe(409);
    const ok = await req("PUT", "/api/file", { body: { path: sb.draft, content: text + "\nThe writer typed this.", base_hash: hashText(text) } });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(sb.draft, "utf8").endsWith("The writer typed this.")).toBe(true);
  });
  it("comment and run routes act only on the open draft", async () => {
    const other = path.join(sb.root, "posts", "other.md");
    expect((await req("POST", "/api/comments/load", { body: { path: other, text: "" } })).status).toBe(403);
    expect((await req("POST", "/api/run", { body: { path: other, perspective: "lint", scope: "document", text: "x" } })).status).toBe(403);
  });
  it("never serves licensed or private workspace material", async () => {
    const r = await req("GET", `/api/workspace-file?path=${encodeURIComponent(path.join(sb.priv, "INDEX.md"))}`);
    expect(r.status).toBe(403);
    const ok = await req("GET", `/api/workspace-file?path=${encodeURIComponent(path.join(sb.root, "notes.md"))}`);
    expect(ok.status).toBe(200);
  });
  it("refuses a reference folder outside the allowed roots", async () => {
    const r = await req("PUT", "/api/context", { body: { path: sb.draft, context: { reference_folders: ["/etc"] } } });
    expect(r.status).toBe(400);
  });
});

describe("Word routes", () => {
  function raw(p: string, body: Buffer) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: p, headers: { host: `127.0.0.1:${PORT}`, cookie, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/octet-stream" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(d || "{}") }));
      });
      r.on("error", reject);
      r.end(body);
    });
  }
  it("rejects a non-docx upload and a folder outside the drafts root", async () => {
    expect((await raw(`/api/import?dir=${encodeURIComponent(sb.postDir)}&name=x.docx`, Buffer.from("not a zip"))).status).toBe(400);
    expect((await raw(`/api/import?dir=${encodeURIComponent("/etc")}&name=x.docx`, Buffer.from("PK"))).status).toBe(403);
  });
  it("imports a docx into the folder and writes markdown, images and sidecar comments", async () => {
    const { execFileSync } = await import("node:child_process");
    const src = path.join(sb.root, "word-src.md");
    fs.writeFileSync(src, "# Title heading\n\nBody with a note.[^1]\n\n[^1]: The note.\n");
    const docx = path.join(sb.root, "upload.docx");
    execFileSync("pandoc", [src, "-o", docx]);
    const r = await raw(`/api/import?dir=${encodeURIComponent(sb.postDir)}&name=${encodeURIComponent("My Report v2.docx")}`, fs.readFileSync(docx));
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(path.join(sb.postDir, "my-report-v2.md"));
    const md = fs.readFileSync(r.json.path, "utf8");
    expect(md).toMatch(/\[\^FN01-[a-z0-9]{4}\]: The note\./);
    expect(md).toContain("source_docx: My Report v2.docx");
  });
  it("exports the open draft, refuses to overwrite silently, and refuses paths under .git", async () => {
    const text = fs.readFileSync(sb.draft, "utf8");
    const out = path.join(sb.postDir, "export-test.docx");
    const body = { path: sb.draft, text, template: "plain", scope: "body", notes: "as-labelled", comments: "none", out_path: out };
    const first = await req("POST", "/api/export", { body });
    expect(first.status).toBe(200);
    expect(fs.existsSync(out)).toBe(true);
    expect((await req("POST", "/api/export", { body })).status).toBe(409);
    expect((await req("POST", "/api/export", { body: { ...body, overwrite: true } })).status).toBe(200);
    expect((await req("POST", "/api/export", { body: { ...body, out_path: path.join(sb.root, ".git", "x.docx") } })).status).toBe(403);
    expect((await req("POST", "/api/reveal", { body: { path: "/etc/hosts" } })).status).toBe(403);
  });
  it("serves images beside the open draft only", async () => {
    fs.mkdirSync(path.join(sb.postDir, "images"), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "docx", "chart.png"), path.join(sb.postDir, "images", "c.png"));
    expect((await req("GET", `/api/asset?rel=${encodeURIComponent("images/c.png")}`)).status).toBe(200);
    expect((await req("GET", `/api/asset?rel=${encodeURIComponent("../../profile.yaml")}`)).status).toBe(404);
    fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "docx", "chart.png"), path.join(sb.root, "outside.png"));
    expect((await req("GET", `/api/asset?rel=${encodeURIComponent("../../outside.png")}`)).status).toBe(403);
  });
});

describe("new draft", () => {
  it("creates the folder and a titled file, then refuses to replace it", async () => {
    const dir = path.join(sb.root, "articles", "new-folder");
    const r = await req("POST", "/api/new", { body: { dir, title: "The cost of delay: part 2", name: "" } });
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(path.join(dir, "the-cost-of-delay-part-2.md"));
    const text = fs.readFileSync(r.json.path, "utf8");
    expect(text).toMatch(/^---\ntitle: "The cost of delay: part 2"\ndate: \d{4}-\d{2}-\d{2}\nstatus: draft\n---\n\n<!-- body -->\n\n$/);
    expect((await req("POST", "/api/new", { body: { dir, title: "The cost of delay: part 2", name: "" } })).status).toBe(409);
  });
  it("refuses folders outside the drafts root and inside .git", async () => {
    expect((await req("POST", "/api/new", { body: { dir: "/etc", title: "x", name: "" } })).status).toBe(403);
    expect((await req("POST", "/api/new", { body: { dir: path.join(sb.root, ".git"), title: "x", name: "" } })).status).toBe(403);
  });
  it("opens the new file and saves typed text into it", async () => {
    const dir = path.join(sb.root, "articles");
    const p = (await req("POST", "/api/new", { body: { dir, title: "Fresh", name: "fresh piece" } })).json.path;
    expect(p).toBe(path.join(dir, "fresh-piece.md"));
    const opened = await req("GET", `/api/file?path=${encodeURIComponent(p)}`);
    expect(opened.status).toBe(200);
    const ok = await req("PUT", "/api/file", { body: { path: p, content: opened.json.content + "First line.\n", base_hash: opened.json.hash } });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(p, "utf8").endsWith("First line.\n")).toBe(true);
  });
});

describe("recent files", () => {
  it("lists opened, edited and created drafts newest first, at most ten, skipping deleted ones", async () => {
    const dir = path.join(sb.root, "recent");
    const made: string[] = [];
    for (let i = 1; i <= 12; i++) made.push((await req("POST", "/api/new", { body: { dir, title: `Piece ${i}`, name: "" } })).json.path);
    let r = (await req("GET", "/api/recent")).json.recent;
    expect(r).toHaveLength(10);
    expect(r[0]).toMatchObject({ path: made[11], action: "created" });
    fs.rmSync(made[11]);
    const opened = await req("GET", `/api/file?path=${encodeURIComponent(made[3])}`);
    await req("PUT", "/api/file", { body: { path: made[3], content: opened.json.content + "x", base_hash: opened.json.hash } });
    r = (await req("GET", "/api/recent")).json.recent;
    expect(r[0]).toMatchObject({ path: made[3], action: "edited" });
    expect(r.some((e: any) => e.path === made[11])).toBe(false);
    expect(r).toHaveLength(10);
    expect(new Set(r.map((e: any) => e.path)).size).toBe(10);
  });
});

describe("stopping", () => {
  it("stops by itself when no tab is open for the idle time", async () => {
    const p2 = spawn(path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsx"), ["server/index.ts", "--no-browser"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { ...process.env, DRAFTROOM_PROFILE: sb.profPath, DRAFTROOM_PORT: "8798", DRAFTROOM_HOME: sb.home, DRAFTROOM_IDLE_MINUTES: "0.02" },
    });
    let out = "";
    p2.stdout!.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => { p2.kill(); resolve(-1); }, 15_000);
      p2.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    expect(code).toBe(0);
    expect(out).toMatch(/stopped: no Draftroom tab open/);
  }, 20_000);
  // Last: Quit stops the shared test server.
  it("Quit requires the cookie and Origin, then stops the server", async () => {
    expect((await req("POST", "/api/quit", { body: {}, origin: null })).status).toBe(403);
    const exited = new Promise<number | null>((resolve) => proc.on("exit", (c) => resolve(c)));
    expect((await req("POST", "/api/quit", { body: {} })).status).toBe(200);
    expect(await exited).toBe(0);
  });
});

describe("program folder", () => {
  it("New refuses Draftroom's own folder", async () => {
    const { createDraft } = await import("../server/files.ts");
    const { loadProfile, REPO } = await import("../server/profile.ts");
    const prof = { ...loadProfile(sb.profPath), drafts_root: path.dirname(REPO) };
    expect(() => createDraft(prof, REPO, "", "Stray draft")).toThrow(/program folder/);
  });
});


describe("images", () => {
  it("saves an image beside the draft by its bytes, reuses an identical one, never overwrites", async () => {
    const { saveDraftImage } = await import("../server/files.ts");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-a")]);
    const png2 = Buffer.concat([png, Buffer.from("b")]);
    const a = saveDraftImage(sb.draft, "Medicare Timeline.PNG", png);
    expect(a.rel).toMatch(/^images\/[a-z0-9-]+-medicare-timeline\.png$/);
    expect(fs.existsSync(path.join(path.dirname(sb.draft), a.rel))).toBe(true);
    expect(saveDraftImage(sb.draft, "Medicare Timeline.png", png)).toEqual({ rel: a.rel, reused: true });
    expect(saveDraftImage(sb.draft, "Medicare Timeline.png", png2).rel).toMatch(/-2\.png$/);
    expect(() => saveDraftImage(sb.draft, "evil.png", Buffer.from("<svg onload=alert(1)>"))).toThrow(/PNG, JPEG/);
  });
});
