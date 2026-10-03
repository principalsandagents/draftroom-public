---
id: lint
name: Lint
colour: "#8a8f98"
level: sentence
scopes: [selection, paragraph, section, document]
default_scope: document
engine: lint
tools: []
max_comments: 40
needs: []
profile_files: []
shortcut: 0
release: 1
---
<!-- tell-lint: off -->
Mechanical checks with no model and no tokens: the workspace's `tell-lint.py` rules (fails and warnings) plus readability counts (sentences over 35 words, hedge-heavy and passive-heavy paragraphs). Runs instantly. This file documents the perspective; the engine is `server/engines/lint.ts`.
