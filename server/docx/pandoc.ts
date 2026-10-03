// Pandoc subprocess helper and small AST utilities shared by import and export.

import { spawn } from "node:child_process";

export const PANDOC = process.env.DRAFTROOM_PANDOC ?? "pandoc";

export class PandocError extends Error {}

export function runPandoc(args: string[], input?: string | Buffer, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(PANDOC, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(t);
      reject(new PandocError(`pandoc not available (${e.message}); install with: brew install pandoc`));
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new PandocError(`pandoc exited ${code}: ${err.slice(0, 400)}`));
    });
    p.stdin.end(input ?? "");
  });
}

export async function pandocVersion(): Promise<string> {
  return (await runPandoc(["--version"])).split("\n")[0];
}

// ---------------------------------------------------------------- AST helpers (pandoc JSON)

export type Node = { t: string; c?: any };

/** Plain text of inlines or blocks, like pandoc's stringify. */
export function stringify(x: any): string {
  if (Array.isArray(x)) return x.map(stringify).join("");
  if (!x || typeof x !== "object") return "";
  switch (x.t) {
    case "Str":
      return x.c;
    case "Space":
    case "SoftBreak":
    case "LineBreak":
      return " ";
    case "Code":
    case "Math":
      return x.c[1];
    case "RawInline":
      return "";
    case "Note":
      return "";
    case "Image":
      return stringify(x.c[1]);
    case "Link":
    case "Span":
      return stringify(x.c[1]);
    case "Quoted":
      return (x.c[0].t === "SingleQuote" ? "‘" : "“") + stringify(x.c[1]) + (x.c[0].t === "SingleQuote" ? "’" : "”");
    case "Cite":
      return stringify(x.c[1]);
    case "Emph":
    case "Strong":
    case "Strikeout":
    case "Superscript":
    case "Subscript":
    case "SmallCaps":
    case "Underline":
      return stringify(x.c);
    case "Para":
    case "Plain":
    case "Header":
      return stringify(x.t === "Header" ? x.c[2] : x.c) + "\n";
    default:
      return Array.isArray(x.c) ? stringify(x.c) : "";
  }
}

export function attrOf(node: Node): { id: string; classes: string[]; kv: Record<string, string> } | null {
  if (!["Span", "Div", "Link", "Image", "Header", "Code", "CodeBlock", "Table", "Figure"].includes(node.t)) return null;
  const a = node.t === "Header" ? node.c[1] : node.c[0];
  if (!Array.isArray(a) || a.length !== 3) return null;
  return { id: a[0], classes: a[1], kv: Object.fromEntries(a[2]) };
}

export const EMPTY_ATTR = ["", [], []];

export function str(s: string): Node {
  return { t: "Str", c: s };
}

/** Offsets of markdown grid tables. Their cells are fixed-width: edits inside must keep widths. */
export function gridRanges(md: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /^\+[-=:+]+\+[ \t]*\n(?:[|+][^\n]*\n?)*/gm;
  for (const m of md.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Apply f to the text outside grid tables only. */
export function outsideGrids(md: string, f: (s: string) => string): string {
  let out = "";
  let last = 0;
  for (const [a, b] of gridRanges(md)) {
    out += f(md.slice(last, a)) + md.slice(a, b);
    last = b;
  }
  return out + f(md.slice(last));
}
