// Load perspective prompt files: YAML frontmatter plus a markdown brief.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { REPO } from "./profile.ts";
import type { PerspectiveMeta } from "../shared/types.ts";

export interface Perspective extends PerspectiveMeta {
  body: string;
}

const DIR = path.join(REPO, "perspectives");

export function loadPerspectives(): Perspective[] {
  const out: Perspective[] = [];
  for (const f of fs.readdirSync(DIR).sort()) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const text = fs.readFileSync(path.join(DIR, f), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!m) throw new Error(`${f}: missing frontmatter`);
    const meta = YAML.parse(m[1]) as PerspectiveMeta;
    if (meta.id !== f.replace(/\.md$/, "")) throw new Error(`${f}: id ${meta.id} does not match the file name`);
    out.push({ ...meta, body: m[2].replace("<!-- tell-lint: off -->", "").trim() });
  }
  return out.sort((a, b) => a.shortcut - b.shortcut);
}

export function preamble(): string {
  return fs.readFileSync(path.join(DIR, "_preamble.md"), "utf8").replace("<!-- tell-lint: off -->", "").trim();
}
