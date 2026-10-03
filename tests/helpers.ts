import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

/** A temp drafts root with a copy of a fixture draft and a matching test profile. */
export function sandbox(fixture = "substack-post.md") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "draftroom-test-")));
  const postDir = path.join(root, "posts", "post-1");
  fs.mkdirSync(postDir, { recursive: true });
  const draft = path.join(postDir, "draft.md");
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "drafts", fixture), draft);
  fs.writeFileSync(path.join(postDir, "sources.md"), "| # | Source | Supports | Status | Note |\n| --- | --- | --- | --- | --- |\n| 1 | Department of Finance policy 2024 | footnote 1 | held | |\n");
  // The public example profile, with absolute paths and the sandbox as its drafts root.
  const profilesDir = path.join(import.meta.dirname, "..", "profiles");
  const prof = YAML.parse(fs.readFileSync(path.join(profilesDir, "example.yaml"), "utf8"));
  for (const f of Object.values(prof.files) as Array<{ path: string }>) f.path = path.resolve(profilesDir, f.path);
  const positions = path.join(root, "positions");
  const priv = path.join(root, "private");
  fs.mkdirSync(positions);
  fs.mkdirSync(priv);
  fs.writeFileSync(path.join(priv, "INDEX.md"), "Private material.\n");
  fs.writeFileSync(path.join(root, "notes.md"), "Readable material.\n");
  Object.assign(prof, {
    drafts_root: root, new_drafts_dir: root, allowed_roots: [root], denied_paths: [priv], positions_dir: positions,
    tell_lint: path.join(import.meta.dirname, "fixtures", "lint", "tell-lint-stub.py"),
  });
  const profPath = path.join(root, "profile.yaml");
  fs.writeFileSync(profPath, YAML.stringify(prof));
  const home = path.join(root, ".home");
  return { root, postDir, draft, profPath, home, priv };
}
