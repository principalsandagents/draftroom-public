-- Complex tables arrive in markdown as raw HTML (merged cells, several paragraphs per cell).
-- The docx writer drops raw HTML, so parse each HTML table into a real pandoc Table.
function RawBlock(el)
  if el.format:match("html") and el.text:match("^%s*<table") then
    return pandoc.read(el.text, "html").blocks
  end
end
