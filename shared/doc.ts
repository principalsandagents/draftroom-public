// Document structure helpers used by both server and client.
// Offsets are JavaScript string indices into the full file text.

export interface Block {
  start: number;
  end: number; // exclusive
  kind: "heading" | "paragraph";
  section: string; // nearest heading text above, "" before the first heading
  index: number; // paragraph number within the body, 1-based; headings get 0
  depth?: number; // heading depth
}

const BODY_MARKER = "<!-- body -->";

/** Where the body starts: after a `<!-- body -->` line if present, else after YAML frontmatter, else 0. */
export function bodyStart(text: string): number {
  const marker = text.lastIndexOf(BODY_MARKER);
  if (marker >= 0) {
    const nl = text.indexOf("\n", marker);
    return nl < 0 ? text.length : nl + 1;
  }
  if (text.startsWith("---\n")) {
    const close = text.indexOf("\n---", 4);
    if (close >= 0) {
      const nl = text.indexOf("\n", close + 4);
      return nl < 0 ? text.length : nl + 1;
    }
  }
  return 0;
}

/** Split the body into heading and paragraph blocks. Fenced code is one paragraph block. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const start = bodyStart(text);
  let section = "";
  let para = 0;
  let i = start;
  let blockStart = -1;
  let inFence = false;

  const flush = (endIdx: number) => {
    if (blockStart < 0) return;
    let e = endIdx;
    while (e > blockStart && /\s/.test(text[e - 1])) e--;
    if (e > blockStart) {
      para += 1;
      out.push({ start: blockStart, end: e, kind: "paragraph", section, index: para });
    }
    blockStart = -1;
  };

  while (i <= text.length) {
    const nl = text.indexOf("\n", i);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(i, lineEnd);

    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence && blockStart < 0) blockStart = i;
      inFence = !inFence;
    } else if (!inFence) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flush(i);
        section = h[2].trim();
        out.push({ start: i, end: lineEnd, kind: "heading", section, index: 0, depth: h[1].length });
      } else if (line.trim() === "") {
        flush(i);
      } else if (blockStart < 0) {
        blockStart = i;
      }
    }
    if (nl < 0) break;
    i = nl + 1;
  }
  flush(text.length);
  return out;
}

export function blockAt(text: string, offset: number, kind: "paragraph" | "section"): { from: number; to: number; section: string } | null {
  const bs = blocks(text);
  if (kind === "paragraph") {
    const b = bs.find((x) => x.kind === "paragraph" && offset >= x.start && offset <= x.end)
      ?? bs.filter((x) => x.kind === "paragraph" && x.start <= offset).pop();
    return b ? { from: b.start, to: b.end, section: b.section } : null;
  }
  // Section: from the heading at or above offset to the next heading of the same or higher level.
  const headings = bs.filter((x) => x.kind === "heading");
  const h = headings.filter((x) => x.start <= offset).pop();
  if (!h) {
    const first = headings[0];
    return { from: bodyStart(text), to: first ? first.start : text.length, section: "" };
  }
  const next = headings.find((x) => x.start > h.start && (x.depth ?? 6) <= (h.depth ?? 6));
  return { from: h.start, to: next ? next.start : text.length, section: h.section };
}

export function locateBlock(text: string, offset: number): { section: string; paragraph: number } {
  const bs = blocks(text);
  const b = bs.filter((x) => x.start <= offset).pop();
  if (!b) return { section: "", paragraph: 0 };
  const lastPara = bs.filter((x) => x.kind === "paragraph" && x.start <= offset).pop();
  return { section: b.section, paragraph: lastPara ? lastPara.index : 0 };
}

/** Headings plus the first twelve words of each paragraph: gives a run the shape of the whole draft. */
export function outline(text: string): string {
  return blocks(text)
    .map((b) => {
      if (b.kind === "heading") return `${"#".repeat(b.depth ?? 2)} ${b.section}`;
      const words = text.slice(b.start, b.end).replace(/\s+/g, " ").trim().split(" ");
      return `  [p${b.index}] ${words.slice(0, 12).join(" ")}${words.length > 12 ? " …" : ""}`;
    })
    .join("\n");
}

export function wordCount(text: string): number {
  const body = text.slice(bodyStart(text));
  const m = body.replace(/<!--[\s\S]*?-->/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

export function hashText(text: string): string {
  // FNV-1a, enough to detect change; not security relevant.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + ":" + text.length;
}
