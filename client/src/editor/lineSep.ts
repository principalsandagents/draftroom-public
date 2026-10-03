// Keep the file byte-identical: a CRLF file stays CRLF.
import { EditorState, type Extension } from "@codemirror/state";

export function lineSeparatorFor(doc: string): Extension {
  return doc.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [];
}
