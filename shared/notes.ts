// Footnotes and endnotes, deterministically: parse, renumber in reading order, convert between
// kinds, replace definitions. Used by the editor toolbar and the Citations feature. No model.
//
// Labels: [^FN01-k3x9] footnote, [^EN07-p2qa] endnote. The number is the note's position among
// notes of its kind in reading order; the suffix is a stable id and never changes.
// Plain labels ([^1], [^note]) are left alone unless adoptPlain is set.

export type NoteKind = "FN" | "EN";

export interface NoteRef {
  label: string;
  start: number; // offset of "[^"
  end: number;
  inDefinition: boolean; // a reference inside another note's definition
}

export interface NoteDef {
  label: string;
  start: number; // offset of "[^label]:"
  end: number; // exclusive, without trailing blank lines
  body: string; // text after "]: ", continuation lines un-indented
}

export interface ParsedNotes {
  refs: NoteRef[];
  defs: NoteDef[];
}

const LABEL = /^(FN|EN)(\d+)-([a-z0-9]+)$/;
const MARKERS = /^<!-- (Footnotes|Endnotes) -->[ \t]*$/;

export function labelParts(label: string): { kind: NoteKind; n: number; suffix: string } | null {
  const m = LABEL.exec(label);
  return m ? { kind: m[1] as NoteKind, n: Number(m[2]), suffix: m[3] } : null;
}

/** Ranges of fenced code, where nothing is a note. */
function fences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
  for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

export function parseNotes(text: string): ParsedNotes {
  const code = fences(text);
  const inCode = (p: number) => code.some(([a, b]) => p >= a && p < b);
  const defs: NoteDef[] = [];
  const defRe = /^\[\^([^\]\s]+)\]:[ \t]?/gm;
  const starts: Array<{ label: string; start: number; bodyStart: number }> = [];
  for (const m of text.matchAll(defRe)) if (!inCode(m.index!)) starts.push({ label: m[1], start: m.index!, bodyStart: m.index! + m[0].length });
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const limit = i + 1 < starts.length ? starts[i + 1].start : text.length;
    // A definition runs until a blank line followed by a line that is not indented (or the next definition).
    let end = limit;
    const rest = text.slice(s.bodyStart, limit);
    const stop = /\n[ \t]*\n(?=[^ \t\n])/.exec(rest);
    if (stop) end = s.bodyStart + stop.index;
    while (end > s.bodyStart && /\s/.test(text[end - 1])) end--;
    const raw = text.slice(s.bodyStart, end);
    defs.push({ label: s.label, start: s.start, end, body: raw.replace(/\n {4}/g, "\n") });
  }
  const inDef = (p: number) => defs.some((d) => p > d.start && p < d.end);
  const refs: NoteRef[] = [];
  for (const m of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
    const p = m.index!;
    if (inCode(p)) continue;
    if (text[p + m[0].length] === ":" && (p === 0 || text[p - 1] === "\n")) continue; // a definition head
    refs.push({ label: m[1], start: p, end: p + m[0].length, inDefinition: inDef(p) });
  }
  return { refs, defs };
}

function randomSuffix(seed: string): string {
  // Deterministic for a given label, so repeated runs give the same result.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += "abcdefghijklmnopqrstuvwxyz0123456789"[h % 36];
    h = Math.floor(h / 36) + (i + 1) * 7919;
  }
  return s;
}

export interface RenumberResult {
  text: string;
  changed: boolean;
  mapping: Record<string, string>; // old label -> new label
  unreferenced: string[];
  nested: string[]; // notes referenced only inside another note (Word and pandoc do not support these)
  repeated: string[]; // notes referenced more than once in the body
  adopted: number;
  error?: string;
}

/** Offsets of markdown grid tables: their cells are fixed-width, so labels inside must keep their length. */
function gridRanges(md: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of md.matchAll(/^\+[-=:+]+\+[ \t]*\n(?:[|+][^\n]*\n?)*/gm)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/**
 * Renumber FN and EN notes by first reference in the body, reorder their definitions, and put
 * them in <!-- Footnotes --> and <!-- Endnotes --> blocks at the end. Unchanged input returns
 * the same string.
 */
export function renumberNotes(text: string, opts: { adoptPlain?: boolean; convert?: Record<string, NoteKind> } = {}): RenumberResult {
  const { refs, defs } = parseNotes(text);
  const grids = gridRanges(text);
  const inGrid = (p: number) => grids.some(([a, b]) => p >= a && p < b);
  const kindOf = (label: string): NoteKind | null => {
    if (opts.convert?.[label]) return opts.convert[label];
    const p = labelParts(label);
    if (p) return p.kind;
    // Plain labels become footnotes when adopted, unless any reference sits in a grid table
    // (the longer label would break the table's widths).
    if (opts.adoptPlain && !refs.some((r) => r.label === label && inGrid(r.start))) return "FN";
    return null;
  };

  // Reading order: first body reference; a note referenced only inside another note follows its parent.
  const order: string[] = [];
  const seen = new Set<string>();
  const nested: string[] = [];
  const defOf = new Map(defs.map((d) => [d.label, d]));
  const visit = (label: string) => {
    if (seen.has(label) || !kindOf(label)) return;
    seen.add(label);
    order.push(label);
    const d = defOf.get(label);
    if (!d) return;
    for (const r of refs) if (r.inDefinition && r.start > d.start && r.start < d.end && !seen.has(r.label)) { nested.push(r.label); visit(r.label); }
  };
  for (const r of refs) if (!r.inDefinition) visit(r.label);
  const unreferenced = defs.map((d) => d.label).filter((l) => kindOf(l) && !seen.has(l));
  const all = [...order, ...unreferenced];
  const bodyCounts = new Map<string, number>();
  for (const r of refs) if (!r.inDefinition) bodyCounts.set(r.label, (bodyCounts.get(r.label) ?? 0) + 1);
  const repeated = [...bodyCounts.entries()].filter(([, n]) => n > 1).map(([l]) => l);

  const counts: Record<NoteKind, number> = { FN: 0, EN: 0 };
  for (const l of all) counts[kindOf(l)!]++;
  const width = (k: NoteKind) => Math.max(2, String(counts[k]).length);
  const next: Record<NoteKind, number> = { FN: 0, EN: 0 };
  const mapping: Record<string, string> = {};
  let adopted = 0;
  for (const l of all) {
    const k = kindOf(l)!;
    const n = ++next[k];
    const parts = labelParts(l);
    const suffix = parts ? parts.suffix : randomSuffix(l);
    if (!parts) adopted++;
    mapping[l] = `${k}${String(n).padStart(width(k), "0")}-${suffix}`;
  }

  // A wider label (past 99 notes, or an adopted plain label) would break a grid table's widths.
  for (const r of refs) {
    const to = mapping[r.label];
    if (to && to.length !== r.label.length && inGrid(r.start)) {
      return { text, changed: false, mapping: {}, unreferenced, nested, repeated, adopted: 0, error: `Cannot renumber: note ${r.label} sits in a grid table and its label would change length` };
    }
  }

  const identity = Object.entries(mapping).every(([a, b]) => a === b);
  const defOrder = defs.filter((d) => mapping[d.label]).map((d) => d.label);
  const sortedDefs = [...defOrder].sort((a, b) => all.indexOf(a) - all.indexOf(b));
  const inOrder = defOrder.every((l, i) => l === sortedDefs[i]);
  if (identity && inOrder) return { text, changed: false, mapping, unreferenced, nested, repeated, adopted: 0 };

  // 1. Rename labels everywhere except in fenced code (references and definition heads).
  const code = fences(text);
  let out = text.replace(/\[\^([^\]\s]+)\]/g, (all0, l, off: number) => (mapping[l] && !code.some(([a, b]) => off >= a && off < b) ? `[^${mapping[l]}]` : all0));
  // 2. Re-parse, lift managed definitions out, and rebuild the blocks at the end.
  const p2 = parseNotes(out);
  const managed = p2.defs.filter((d) => labelParts(d.label));
  const chunks = new Map(managed.map((d) => [d.label, out.slice(d.start, d.end)]));
  // Remove from the end backwards so offsets hold; drop the old block markers too.
  const cuts = [...managed.map((d) => [d.start, d.end] as [number, number])].sort((a, b) => b[0] - a[0]);
  for (const [a, b] of cuts) out = out.slice(0, a) + out.slice(b);
  out = out.split("\n").filter((ln) => !MARKERS.test(ln)).join("\n");
  out = out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  const byNum = (k: NoteKind) => [...chunks.entries()].filter(([l]) => labelParts(l)!.kind === k).sort((a, b) => labelParts(a[0])!.n - labelParts(b[0])!.n).map(([, c]) => c);
  const fn = byNum("FN");
  const en = byNum("EN");
  let tail = "";
  if (fn.length) tail += `\n\n<!-- Footnotes -->\n\n${fn.join("\n\n")}`;
  if (en.length) tail += `\n\n<!-- Endnotes -->\n\n${en.join("\n\n")}`;
  out = `${out}${tail}\n`;
  return { text: out, changed: out !== text, mapping, unreferenced, nested, repeated, adopted };
}

/** Convert notes between footnotes and endnotes (all of a kind, or the listed labels), then renumber. */
export function convertNotes(text: string, from: NoteKind, to: NoteKind, labels?: string[]): RenumberResult {
  const { defs, refs } = parseNotes(text);
  const convert: Record<string, NoteKind> = {};
  for (const l of new Set([...defs.map((d) => d.label), ...refs.map((r) => r.label)])) {
    const p = labelParts(l);
    if (p?.kind === from && (!labels || labels.includes(l))) convert[l] = to;
  }
  // Renaming the kind keeps the label length, so grid tables are safe.
  return renumberNotes(text, { convert });
}

/** Replace the bodies of the given definitions (label -> new body). Labels and order unchanged. */
export function replaceDefinitionBodies(text: string, bodies: Record<string, string>): string {
  const { defs } = parseNotes(text);
  let out = text;
  for (const d of [...defs].sort((a, b) => b.start - a.start)) {
    if (!(d.label in bodies)) continue;
    const head = `[^${d.label}]: `;
    const body = bodies[d.label].replace(/\n/g, "\n    ");
    out = out.slice(0, d.start) + head + body + out.slice(d.end);
  }
  return out;
}
