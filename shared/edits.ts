// Turn a before/after pair into minimal edits, so applying a whole-document change (renumbering,
// accepted citations) leaves untouched text, comment marks and the cursor where they were.

import DiffMatchPatch from "diff-match-patch";

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

const dmp = new DiffMatchPatch();

export function minimalEdits(before: string, after: string): Edit[] {
  if (before === after) return [];
  dmp.Diff_Timeout = 2;
  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);
  const edits: Edit[] = [];
  let pos = 0;
  for (let i = 0; i < diffs.length; i++) {
    const [op, s] = diffs[i];
    if (op === 0) {
      pos += s.length;
    } else if (op === -1) {
      const next = diffs[i + 1];
      if (next && next[0] === 1) {
        edits.push({ from: pos, to: pos + s.length, insert: next[1] });
        i++;
      } else {
        edits.push({ from: pos, to: pos + s.length, insert: "" });
      }
      pos += s.length;
    } else {
      edits.push({ from: pos, to: pos, insert: s });
    }
  }
  return edits;
}

/** Apply edits (in original coordinates) to a string, for tests and the server. */
export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}
