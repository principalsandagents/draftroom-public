# Draftroom

**Version 0.1.1 · 2026-10-03**

Draftroom is a local markdown editor for people who want to write every word themselves and still get AI review. You type the draft. Reviewers ("perspectives") run when you click, through your own Claude and Codex logins, and leave comments anchored to your sentences: what the problem is and which way to fix it. No code path writes model output into the draft. One narrow exception exists (citation formatting, below), and it changes nothing until you accept a preview.

It was built for writing essays, reports and newsletter posts where the argument and the words have to be the author's own.

## Features

- **Editor.** Live-preview markdown (CodeMirror 6), a formatting toolbar, footnotes and endnotes with stable labels, images (button, paste or drag; saved in `images/` beside the draft with a caption), recent files, New draft, and a Draft mode that hides every mark.
- **Review perspectives.** Argument (thesis, unsupported claims, leaps, consistency with your standing positions), Evidence (claims against your sources file and reference folders, quotes, footnotes, your organisation's approved positions), Line and voice (rhythm, register, clarity against your voice card, from a selection up to the whole draft) and Copy and proof (spelling, grammar, consistency). Each comment has a severity, a level and a hint that starts with a verb. Resolve or dismiss; dismissed comments stay quiet until the text changes.
- **A guardrail on every comment.** Hints that supply replacement wording, new facts or long phrases absent from the draft are dropped or flagged before you see them. "Show an example" gives a before-and-after on an unrelated topic and has no copy button.
- **Signals from Jev (optional).** TypeSafe's Jev returns probabilities for fixed paragraph questions (point comes late, fact without a source, over-hedged, contrast frame and others). It is off for every draft until you switch that draft on, sends only cleaned prose paragraphs, and needs your own key in `~/.draftroom/jev.key`.
- **Citations.** Renumber notes in reading order, convert footnotes and endnotes, check every quotation word for word against its fetched or linked source, format notes in AGLC 4 or Chicago 18 through citeproc, and validate references against Crossref, OpenAlex and Unpaywall.
- **Word import and export** through pandoc, keeping notes, tables, images and comments.
- **Lint perspective (off in this release).** It runs a local lint script named in your profile, with no model. No script ships here, so its tab is hidden until you add one; `tests/fixtures/lint/tell-lint-stub.py` shows the interface.

## How it works

```
client/        React app: editor, Advice panel, Context, Citations, Signals
server/        Node HTTP server on 127.0.0.1: files, comment store, run builder, guardrail
server/engines Adapters that spawn the unmodified `claude` and `codex` CLIs, read-only
server/cite/   Citations: notes, quote checks, library, formatting, validation
server/jev/    Jev paragraph selection, state and scoring
server/docx/   Word import and export (pandoc)
perspectives/  One prompt file per reviewer; _preamble.md is the contract every run receives
profiles/      example.yaml: who you are, your voice files, which folders reviewers may read
examples/      Sample voice card, style guide, tells catalogue, line brief, standing positions
shared/        JSON schemas and types used by client and server
tests/         Vitest suites and fixtures
```

Each run builds a prompt from the perspective file, your profile files and the scoped text, starts `claude -p` or `codex exec` in an empty folder under `~/.draftroom/runs/` with read-only tools, validates the JSON that comes back, anchors each comment to the exact span, and stores it in a `.draftroom/` sidecar beside the draft. The server binds 127.0.0.1 only and needs a one-time bootstrap cookie on every request.

## Install and run

Requires Node 22 or later, pandoc (`brew install pandoc`), and the `claude` and `codex` CLIs logged in with your own subscriptions.

```
git clone https://github.com/principalsandagents/draftroom-public.git draftroom
cd draftroom
npm ci
bin/draftroom                    # opens empty: New, Open or Import Word
bin/draftroom path/to/draft.md   # or a folder containing draft.md
```

**Quit** saves and stops the server; it also stops after 15 minutes with no tab open.

## Make it yours

1. Copy `profiles/example.yaml` to `profiles/<you>.yaml`. With one profile besides the example, Draftroom loads it; otherwise set `DRAFTROOM_PROFILE` or put the profile path in `~/.draftroom/profile`.
2. Set `author` (name, how reviewers address you, role, organisation, spelling).
3. Replace the files in `examples/` with your own voice card, style guide, tells catalogue and standing positions, or point the profile at files elsewhere. The voice card goes to every reviewer, so it sets the standard each comment is judged against.
4. Set `drafts_root`, `allowed_roots` and `denied_paths`. Reviewers can read only under allowed roots, never under denied paths.
5. Optional: `positions_dir`, `jev_extra_questions`, `contact_email` (sent only to Crossref, OpenAlex and Unpaywall), `tell_lint`.

Copy and proof assumes Australian spelling and style; edit `perspectives/copy-proof.md` for another.

## What leaves your machine

- **Model runs:** the prompt goes to Anthropic or OpenAI through the CLI you choose, on your plan's quota.
- **Jev:** only for drafts you switch on, only cleaned prose paragraphs plus the audience and frame.
- **Citations:** source addresses you cite are fetched; DOIs or titles, authors and years go to Crossref, OpenAlex and Unpaywall. Draft text never goes to source hosts.
- Word conversion runs locally.

## Development

`npm test` · `npm run typecheck` · `npm run dev` · `npm run smoke` (one real run per engine; spends a little quota). Invariants: `AGENTS.md`. Release notes: `CHANGELOG.md`.

## Who made this, and how

Draftroom was designed and directed by **Nick Davis**, who uses it for his own writing. He writes about AI governance at [Principals & Agents](https://principalsandagents.substack.com).

The code was written by **Claude Opus 5.5** (Anthropic), working in Claude Code under Nick's direction: he set the requirements and invariants, reviewed the output and tested each release. Every commit in the private development history carries a Claude Opus 5.5 co-author line. OpenAI's Codex CLI is one of the two review engines Draftroom calls at run time; it did not write the code. The reviews you get come from whichever Claude and OpenAI models your own CLIs are set to use, and the Signals tab from TypeSafe's Jev.

This README was generated by Claude Opus 5.5 (`claude-opus-5-5`) from the code and the private development notes, and checked by Nick before publication.

This public repository is an anonymised mirror of a private one, rebuilt on each release: personal configuration, drafts and history are left out. Issues are welcome; changes are made upstream and arrive with the next release.

## Licence

MIT. See `LICENSE`. The CSL citation styles in `server/cite/styles/` keep their own licence (`NOTICE.md`).
