// Word style helpers: endnote styles, and the font and colour themes for export templates.

export interface Theme {
  bodyFont: string;
  headingFont: string;
  bodySize: number; // half-points: 22 = 11pt
  line: number; // 240 = single spacing
  headingColor: string; // hex without #
  titleAlign: "left" | "center";
  noteSize: number; // half-points
}

const fonts = (f: string) => `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}" />`;

function styleBlock(xml: string, id: string): { start: number; end: number; text: string } | null {
  const re = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`);
  const m = re.exec(xml);
  return m ? { start: m.index, end: m.index + m[0].length, text: m[0] } : null;
}

function editStyle(xml: string, id: string, f: (s: string) => string): string {
  const b = styleBlock(xml, id);
  return b ? xml.slice(0, b.start) + f(b.text) + xml.slice(b.end) : xml;
}

function setRunProp(style: string, tag: string, el: string): string {
  const re = new RegExp(`<w:${tag}\\b[^>]*/>`);
  if (re.test(style)) return style.replace(re, el);
  if (style.includes("<w:rPr>")) return style.replace("<w:rPr>", `<w:rPr>${el}`);
  return style.replace("</w:style>", `<w:rPr>${el}</w:rPr></w:style>`);
}

/** Add Endnote Text and Endnote Reference styles, cloned from the footnote styles, if missing. */
export function ensureEndnoteStyles(xml: string): string {
  let out = xml;
  const pairs: Array<[string, string, string, string]> = [
    ["FootnoteText", "EndnoteText", "Footnote Text", "endnote text"],
    ["FootnoteReference", "EndnoteReference", "Footnote Reference", "endnote reference"],
  ];
  for (const [from, to, , name] of pairs) {
    if (styleBlock(out, to)) continue;
    const src = styleBlock(out, from);
    const clone = src
      ? src.text.replace(`w:styleId="${from}"`, `w:styleId="${to}"`).replace(/<w:name w:val="[^"]*"\s*\/>/, `<w:name w:val="${name}" />`).replace(/<w:next w:val="FootnoteText"\s*\/>/, `<w:next w:val="EndnoteText" />`)
      : to === "EndnoteReference"
        ? `<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference" /><w:rPr><w:vertAlign w:val="superscript" /></w:rPr></w:style>`
        : `<w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text" /><w:basedOn w:val="Normal" /><w:rPr><w:sz w:val="20" /></w:rPr></w:style>`;
    out = out.replace("</w:styles>", `${clone}</w:styles>`);
  }
  return out;
}

export function applyTheme(xml: string, t: Theme): string {
  let out = xml.replace(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/, (m) =>
    m.replace(/<w:rFonts\b[^>]*\/>/, fonts(t.bodyFont)).replace(/<w:sz w:val="\d+"\s*\/>/, `<w:sz w:val="${t.bodySize}" />`).replace(/<w:szCs w:val="\d+"\s*\/>/, `<w:szCs w:val="${t.bodySize}" />`).replace(/w:val="en-US"/, 'w:val="en-AU"'),
  );
  out = out.replace(/<w:pPrDefault>[\s\S]*?<\/w:pPrDefault>/, `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${t.line}" w:lineRule="auto" /></w:pPr></w:pPrDefault>`);
  for (const id of ["Title", "Subtitle", ...Array.from({ length: 9 }, (_, i) => `Heading${i + 1}`)]) {
    out = editStyle(out, id, (s) => {
      let r = setRunProp(s, "rFonts", fonts(t.headingFont));
      r = setRunProp(r, "color", `<w:color w:val="${t.headingColor}" />`);
      if (id === "Title" || id === "Subtitle") r = r.replace(/<w:jc w:val="\w+"\s*\/>/, `<w:jc w:val="${t.titleAlign}" />`);
      return r;
    });
  }
  for (const id of ["FootnoteText", "EndnoteText"]) out = editStyle(out, id, (s) => setRunProp(s, "sz", `<w:sz w:val="${t.noteSize}" />`));
  return out;
}
