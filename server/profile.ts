// Profile loading and the path policy. Every path is realpath-resolved before it is checked.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import crypto from "node:crypto";
import os from "node:os";

export interface ProfileFile {
  path: string;
  section?: string;
}

/** Who the reviewers are working for. Every model prompt reads these; nothing else does. */
export interface Author {
  name?: string; // "Sam Writer"
  short?: string; // how prompts refer to the writer: "Sam"
  description?: string; // one line on role, shown to reviewers
  org?: string; // short name of the writer's organisation, for positions checks
  spelling?: string; // "Australian", "British", "American"
}

export interface Voice {
  key: string;
  label: string;
}

export interface Profile {
  name: string;
  author?: Author;
  voices?: Voice[]; // Context tab voice options
  publications?: Record<string, { publication: string; voice?: string }>; // frontmatter `project` → Context pre-fill
  jev_extra_questions?: string; // YAML list of extra Jev questions, merged after the built-in set
  workspace?: string;
  python?: string;
  files: Record<string, ProfileFile>;
  tell_lint?: string; // unset: the Lint perspective is off
  standards_search?: string;
  positions_dir?: string; // unset: Evidence has no positions folder
  exemplars?: string[];
  allowed_roots: string[];
  drafts_root: string;
  denied_paths: string[];
  new_drafts_dir?: string; // where New starts
  library_dir?: string; // shared reference library (cards tracked; files, text and index private)
  cite_denied_domains?: string[]; // paid or licensed sources: cited as leads, never fetched
  contact_email?: string; // sent only to Crossref, OpenAlex and Unpaywall (Release C)
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export const DEFAULT_VOICES: Voice[] = [
  { key: "personal", label: "Personal" },
  { key: "institutional", label: "Institutional" },
  { key: "co-authored", label: "Co-authored" },
];

/**
 * Which profile to load: DRAFTROOM_PROFILE, then the name or path in ~/.draftroom/profile,
 * then the one profile in profiles/ other than example.yaml, then example.yaml.
 */
export function profileName(): string {
  if (process.env.DRAFTROOM_PROFILE) return process.env.DRAFTROOM_PROFILE;
  const home = process.env.DRAFTROOM_HOME ?? path.join(os.homedir(), ".draftroom");
  try {
    const named = fs.readFileSync(path.join(home, "profile"), "utf8").trim();
    if (named) return named;
  } catch {
    /* no pointer file */
  }
  // A profile is a YAML file with a `files` map; other YAML in profiles/ (extra Jev questions) is not.
  const own = fs.readdirSync(path.join(REPO, "profiles")).filter((f) => {
    if (!f.endsWith(".yaml") || f === "example.yaml") return false;
    try {
      const y = YAML.parse(fs.readFileSync(path.join(REPO, "profiles", f), "utf8"));
      return !!y && typeof y === "object" && !Array.isArray(y) && typeof y.files === "object";
    } catch {
      return false;
    }
  });
  return own.length === 1 ? own[0].replace(/\.yaml$/, "") : "example";
}

/** Expand ~ and resolve a relative path against the profile's folder. */
function resolveFrom(base: string, p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(base, p);
}

export function loadProfile(name = profileName()): Profile {
  // A name resolves to profiles/<name>.yaml; an absolute path (tests, pointer file) is used as is.
  const p = path.isAbsolute(name) ? name : path.join(REPO, "profiles", `${name}.yaml`);
  const prof = YAML.parse(fs.readFileSync(p, "utf8")) as Profile;
  const base = path.dirname(p);
  const at = (x: string) => resolveFrom(base, x);
  for (const f of Object.values(prof.files)) f.path = at(f.path);
  for (const k of ["workspace", "tell_lint", "standards_search", "positions_dir", "drafts_root", "new_drafts_dir", "library_dir", "jev_extra_questions"] as const) {
    if (prof[k]) prof[k] = at(prof[k]!);
  }
  prof.allowed_roots = (prof.allowed_roots ?? []).map(at);
  prof.denied_paths = (prof.denied_paths ?? []).map(at);
  prof.exemplars = (prof.exemplars ?? []).map(at);
  const missing: string[] = [];
  for (const [k, f] of Object.entries(prof.files)) if (!fs.existsSync(f.path)) missing.push(`${k}: ${f.path}`);
  for (const k of ["tell_lint", "standards_search", "positions_dir", "jev_extra_questions"] as const) if (prof[k] && !fs.existsSync(prof[k]!)) missing.push(`${k}: ${prof[k]}`);
  if (missing.length) {
    // Fail loudly: a missing voice card would silently weaken every review.
    throw new Error(`profile ${name} references missing files:\n  ${missing.join("\n  ")}`);
  }
  prof.allowed_roots = prof.allowed_roots.filter((r) => fs.existsSync(r)).map(real);
  prof.denied_paths = prof.denied_paths.map((d) => (fs.existsSync(d) ? real(d) : d));
  prof.drafts_root = real(prof.drafts_root);
  return prof;
}

/** Replace {{author.*}} and {{spelling}} tokens in reviewer instructions. Never applied to draft text. */
export function personalise(prof: Profile, text: string): string {
  const a = prof.author ?? {};
  const vals: Record<string, string> = {
    "author.name": a.name ?? "the writer",
    "author.short": a.short ?? "the writer",
    "author.description": a.description ? ` (${a.description})` : "",
    "author.org": a.org ?? "the writer's organisation",
    spelling: a.spelling ?? "consistent",
  };
  const out = text.replace(/\{\{\s*([a-z.]+)\s*\}\}/g, (m, k: string) => vals[k] ?? m);
  const left = /\{\{\s*[a-z.]+\s*\}\}/.exec(out);
  if (left) throw new Error(`unknown token ${left[0]} in reviewer instructions`);
  return out;
}

export function real(p: string): string {
  return fs.realpathSync(p);
}

/** realpath for a path that may not exist yet: resolve the nearest existing parent. */
export function realLoose(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

export function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const FORBIDDEN_SEGMENTS = new Set([".git", ".claude", ".codex", "node_modules", ".draftroom"]);

export function hasForbiddenSegment(p: string): boolean {
  return p.split(path.sep).some((s) => FORBIDDEN_SEGMENTS.has(s));
}

export function isDenied(prof: Profile, p: string): boolean {
  return prof.denied_paths.some((d) => isUnder(p, d));
}

/** May this path be opened and saved as a draft? */
export function draftPathAllowed(prof: Profile, p: string): { ok: boolean; why?: string; real?: string } {
  const r = realLoose(p);
  if (!r.toLowerCase().endsWith(".md")) return { ok: false, why: "only .md files" };
  if (!isUnder(r, prof.drafts_root)) return { ok: false, why: `outside ${prof.drafts_root}` };
  if (hasForbiddenSegment(r)) return { ok: false, why: "path inside .git, .claude, .codex, node_modules or .draftroom" };
  if (isDenied(prof, r)) return { ok: false, why: "denied path (licensed or private material)" };
  return { ok: true, real: r };
}

/** May this path be read (read-only drawer, reference folder for a model run)? */
export function readPathAllowed(prof: Profile, p: string, extraRoots: string[] = []): { ok: boolean; why?: string; real?: string } {
  if (!path.isAbsolute(p)) return { ok: false, why: "absolute paths only" };
  if (!fs.existsSync(p)) return { ok: false, why: "does not exist" };
  const r = real(p);
  const roots = [...prof.allowed_roots, ...extraRoots];
  if (!roots.some((root) => isUnder(r, root))) return { ok: false, why: "outside the allowed roots" };
  if (isDenied(prof, r)) return { ok: false, why: "denied path (licensed or private material)" };
  if (r.split(path.sep).some((s) => s === ".git")) return { ok: false, why: "inside .git" };
  return { ok: true, real: r };
}

/**
 * Distilled profile files (such as the line brief) list their sources with a hash in YAML
 * frontmatter. Report any whose sources have changed since, so the distillation gets reviewed.
 */
export function profileWarnings(prof: Profile): string[] {
  const out: string[] = [];
  for (const [key, f] of Object.entries(prof.files)) {
    const text = fs.readFileSync(f.path, "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!fm) continue;
    const meta = YAML.parse(fm[1]) as { sources?: Array<{ path: string; sha1: string }> };
    for (const src of meta?.sources ?? []) {
      const s = { ...src, path: path.resolve(path.dirname(f.path), src.path) };
      if (!fs.existsSync(s.path)) { out.push(`${path.basename(f.path)}: source ${path.basename(s.path)} is missing`); continue; }
      const now = crypto.createHash("sha1").update(fs.readFileSync(s.path)).digest("hex").slice(0, 12);
      if (now !== s.sha1) out.push(`${path.basename(s.path)} has changed since ${path.basename(f.path)} was written: review the ${key.replace(/_/g, " ")} (and update its sha1).`);
    }
  }
  return out;
}

/** Read a profile file, optionally just one heading's section. Frontmatter is never sent. */
export function profileText(prof: Profile, key: string): string {
  const f = prof.files[key];
  if (!f) throw new Error(`profile has no file "${key}"`);
  const text = fs.readFileSync(f.path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replace("<!-- tell-lint: off -->", "");
  if (!f.section) return text;
  const i = text.indexOf(f.section);
  if (i < 0) throw new Error(`section "${f.section}" not found in ${f.path}`);
  const level = /^#+/.exec(f.section)?.[0].length ?? 2;
  const re = new RegExp(`\\n#{1,${level}}\\s`, "g");
  re.lastIndex = i + f.section.length;
  const m = re.exec(text);
  return text.slice(i, m ? m.index : text.length).trim();
}

export { REPO };
