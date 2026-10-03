// Draft files: open, save (only the editor buffer, only files opened this session), watch.

import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { draftPathAllowed, hasForbiddenSegment, isDenied, isUnder, REPO, type Profile } from "./profile.ts";

const IMAGE_MAGIC: Array<[string, (b: Buffer) => boolean]> = [
  ["png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["jpg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/**
 * Save an image into an images/ folder beside the draft and return its path relative to the draft.
 * The type comes from the file's bytes, never its name. Never overwrites: the same picture added
 * twice is reused, a different one with the same name gets a number.
 */
export function saveDraftImage(draft: string, name: string, bytes: Buffer): { rel: string; reused: boolean } {
  const ext = IMAGE_MAGIC.find(([, ok]) => ok(bytes))?.[0];
  if (!ext) throw new FileError("Add a PNG, JPEG, GIF or WebP image.", 400);
  const dir = path.join(path.dirname(draft), "images");
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.basename(draft).replace(/\.md$/i, "");
  const base = name.replace(/\.[a-z0-9]+$/i, "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "image";
  for (let i = 1; i < 1000; i++) {
    const file = `${stem}-${base}${i > 1 ? `-${i}` : ""}.${ext}`;
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      if (fs.readFileSync(p).equals(bytes)) return { rel: `images/${file}`, reused: true };
      continue;
    }
    fs.writeFileSync(p, bytes, { flag: "wx" });
    return { rel: `images/${file}`, reused: false };
  }
  throw new FileError("too many images with this name", 409);
}

/** The Draftroom program folder is not a writing folder: New and Import refuse it. */
export function insideProgram(p: string): boolean {
  return isUnder(path.resolve(p), REPO);
}
import { hashText, wordCount } from "../shared/doc.ts";

const opened = new Map<string, string>(); // real path -> last hash we read or wrote
let watcher: FSWatcher | null = null;

export class FileError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** A folder opens its draft.md, else its newest .md file. */
export function resolveTarget(prof: Profile, p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const draft = path.join(abs, "draft.md");
    if (fs.existsSync(draft)) return draft;
    const mds = fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => ({ f, t: fs.statSync(path.join(abs, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!mds.length) throw new FileError(`no .md file in ${abs}`, 404);
    return path.join(abs, mds[0].f);
  }
  return abs;
}

export function openFile(prof: Profile, p: string, onExternalChange: (path: string, hash: string) => void) {
  const target = resolveTarget(prof, p);
  const ok = draftPathAllowed(prof, target);
  if (!ok.ok) throw new FileError(`cannot open ${target}: ${ok.why}`, 403);
  const real = ok.real!;
  const content = fs.existsSync(real) ? fs.readFileSync(real, "utf8") : "";
  const hash = hashText(content);
  opened.set(real, hash);
  if (!watcher) {
    watcher = watch([], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } });
    watcher.on("change", (fp) => {
      if (!fs.existsSync(fp)) return;
      const h = hashText(fs.readFileSync(fp, "utf8"));
      if (opened.has(fp) && opened.get(fp) !== h) onExternalChange(fp, h);
    });
  }
  watcher.add(real);
  return { path: real, content, hash, words: wordCount(content) };
}

export function saveFile(prof: Profile, p: string, content: string, baseHash: string) {
  const ok = draftPathAllowed(prof, p);
  if (!ok.ok) throw new FileError(`cannot save ${p}: ${ok.why}`, 403);
  const real = ok.real!;
  if (!opened.has(real)) throw new FileError("only files opened in this session can be saved", 403);
  const disk = fs.existsSync(real) ? hashText(fs.readFileSync(real, "utf8")) : hashText("");
  if (disk !== baseHash) throw new FileError("the file changed on disk since you loaded it", 409);
  const tmp = `${real}.draftroom-tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, real);
  const hash = hashText(content);
  opened.set(real, hash);
  return { path: real, hash, words: wordCount(content) };
}

export function acceptDisk(real: string, hash: string) {
  if (opened.has(real)) opened.set(real, hash);
}

/** Words to a file name: "The cost of delay, part 1" → the-cost-of-delay-part-1.md */
export function fileNameFor(name: string): string {
  const base = name.trim().replace(/\.md$/i, "");
  const slug = base.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${slug || "untitled"}.md`;
}

/**
 * Start a new draft: create the folder if needed and write a file with a title in the
 * frontmatter and a body marker. Never overwrites: an existing file is an error.
 */
export function createDraft(prof: Profile, dir: string, name: string, title: string): string {
  if (!path.isAbsolute(dir)) throw new FileError("folder must be an absolute path", 400);
  const target = path.join(dir, fileNameFor(name || title));
  const ok = draftPathAllowed(prof, target);
  if (!ok.ok) throw new FileError(`cannot create ${target}: ${ok.why}`, 403);
  if (insideProgram(ok.real!)) throw new FileError("That is Draftroom's program folder: choose a writing folder (for example outputs/drafts)", 403);
  if (fs.existsSync(ok.real!)) throw new FileError(`${ok.real} already exists`, 409);
  fs.mkdirSync(path.dirname(ok.real!), { recursive: true });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
  const t = (title || name).replace(/\s+/g, " ").trim().replace(/\\/g, "").replace(/"/g, '\\"');
  fs.writeFileSync(ok.real!, `---\ntitle: "${t}"\ndate: ${today}\nstatus: draft\n---\n\n<!-- body -->\n\n`, { flag: "wx" });
  return ok.real!;
}

/** List folders and .md files for the open dialog. */
export function browse(prof: Profile, dir: string) {
  const abs = fs.realpathSync(path.resolve(dir));
  if (!isUnder(abs, prof.drafts_root)) throw new FileError("outside the drafts root", 403);
  if (hasForbiddenSegment(abs) || isDenied(prof, abs)) throw new FileError("folder not available", 403);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .filter((e) => e.isDirectory() || e.name.toLowerCase().endsWith(".md"))
    .filter((e) => !isDenied(prof, path.join(abs, e.name)))
    .map((e) => ({ name: e.name, dir: e.isDirectory(), path: path.join(abs, e.name), mtime: fs.statSync(path.join(abs, e.name)).mtimeMs }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { dir: abs, parent: abs === prof.drafts_root ? null : path.dirname(abs), entries };
}

export async function closeWatcher() {
  await watcher?.close();
}
