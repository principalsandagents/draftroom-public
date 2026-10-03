# AGENTS.md

**Draftroom** is a local markdown editor where the writer types every word, and on-demand review agents ("perspectives") run through the writer's own Claude and Codex subscriptions and give anchored feedback in a side panel. These are the rules any agent or contributor working on the code must keep.

## Invariants

Break one and the tool stops doing its job, or something leaks.

- **No code path writes model output into a draft file.** The draft is written only by `PUT /api/file`, whose body is the editor's own buffer.
- **Other files Draftroom writes, each only on the writer's click:** an imported draft (`<name>.md` plus `images/`) in the folder they chose; a `.docx` export (never over an existing file without their "replace"); `sources.md` rows through `server/sources.ts` (Release 2; title, link or path and status only). Everything else goes to `~/.draftroom/` or a `.draftroom/` sidecar folder.
- **Word conversion runs pandoc locally.** No document is sent anywhere. Import never writes outside the chosen folder; export output paths pass the same draft-path policy as saves.
- **Hints and examples have no copy button** and pass `server/guard.ts` before storage.
- **Engines run only through `server/engines/*`**, from a clean run directory under `~/.draftroom/runs/`, read-only, with the argv templates in those files. Never `--dangerously-*`, never `--bare` (it refuses OAuth), never `--add-dir` or `--search` on Codex, never an API key variable in a spawned environment.
- **Never read, store or forward Claude or ChatGPT credentials.** The CLIs hold them; Draftroom only spawns the unmodified binaries.
- **Licensed or denied-path text never enters a web-enabled run.** The Evidence web pass is Claude-only with `WebSearch,WebFetch` and no file tools. Sidecars stay gitignored.
- **At most three concurrent model runs, and nothing runs automatically.**
- **Lint runs only a script the profile names** (`tell_lint`). With none, the Lint tab is hidden and comment-text linting is skipped.
- **Jev is the one networked engine with a key.** It reads `~/.draftroom/jev.key` (mode 600, never logged, never sent to the browser) and sends only to https or localhost. It sends only the classifier's cleaned prose paragraphs (`server/jev/select.ts`) with the audience and frame, only for drafts the writer has switched on (the server enforces the per-draft switch), never for drafts under denied paths, `partnerships/` or with a Context sensitivity flag, and never workspace files, frontmatter, Prep, blockquotes, tables, lists or notes. Card text is fixed in `perspectives/jev-signals.yaml`; Jev supplies numbers only.
- **Citations fetch only cited public sources.** `server/cite/fetch.ts` refuses private, loopback and `file:` addresses at every redirect, and never fetches denylisted domains (paid newsletters, standards stores: `cite_denied_domains`). Fetched and linked sources go to the shared library (`library_dir`): record cards tracked, files, text and the cited-by index private. A linked file whose content matches anything under `denied_paths` is refused. Draft text is never sent to source hosts.
- **The one exception to "model output never enters the draft" is Citations formatting**: Claude only parses notes (segments must reproduce the note exactly; fields not in the note are dropped); citeproc writes the citation text; only citation segments of note definitions change, never commentary, never body text; only after the writer accepts a preview, applied through the editor; a note that would lose words is left unticked. Renumbering, conversion and the quote check use no model.
- **Validation sends**: to Crossref, OpenAlex and Unpaywall only the DOI or title, authors and year, with `contact_email`; to source hosts a plain request for the cited address; to Claude the claim sentence with the abstract and code-chosen passages. A Claude judgement whose quoted passage is not in the source is set aside.
- **Identity lives only in profiles.** Reviewer prompts refer to the writer through `{{author.*}}` tokens filled from the profile; code, prompts and tests name no real person.
- **The server binds 127.0.0.1 only**, needs the bootstrap cookie on every request, allowlists Host, and requires an allowlisted Origin on every non-GET request.

## Structure

| Path | Purpose |
| --- | --- |
| `server/` | Node HTTP server (`index.ts`), files and watcher, comment store and anchoring, guardrail, run builder, engine adapters |
| `client/` | Vite + React app: CodeMirror 6 live-preview editor and the Advice panel |
| `shared/` | JSON schemas and TypeScript types shared by both |
| `server/docx/` | Word import and export, styles and endnote handling, the Lua filter for complex tables |
| `server/cite/` | Citations: notes, quote checks, library, citeproc formatting, validation |
| `server/jev/`, `server/engines/jev.ts` | Jev signals: paragraph classifier, per-draft state and cache, scoring pass, TypeSafe client |
| `templates/` | Word export styles; `templates.json` lists them |
| `perspectives/` | One prompt file per perspective; `_preamble.md` is the hint contract every model run receives |
| `profiles/example.yaml` | The writer: author fields, voice files, allowed and denied paths, optional features |
| `examples/` | Sample voice card, style guide, tells catalogue, line brief, standing positions, Jev questions |
| `tests/` | Vitest suites and fixtures; `scripts/smoke.ts` makes one real run per engine |

## Running and testing

- `bin/draftroom [file-or-folder]` builds the client, starts the server and opens the bootstrap URL.
- `npm run dev` for development (Vite on 5173, server on 8790 with `--dev`).
- `npm test`, `npm run typecheck`, `npm run smoke` (smoke spends a little subscription quota). Run smoke after any `claude` or `codex` update.

## Writing

Prose in this repo (docs, perspective prompts, comment text the agents produce) follows the voice card the profile names. Perspective prompt files quote bad example comments and so start with `<!-- tell-lint: off -->`.
