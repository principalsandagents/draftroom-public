// Types matching shared/schema/*.json. Keep the two in step.

export type Level = "argument" | "structure" | "paragraph" | "sentence" | "mechanics";
export type Severity = "must" | "should" | "consider";
export type Kind = "question" | "observation" | "direction" | "check" | "praise";
export type Scope = "document" | "section" | "paragraph" | "selection" | "none";
export type EngineName = "claude" | "codex" | "lint" | "word" | "jev" | "cite";

export const LEVELS: Level[] = ["argument", "structure", "paragraph", "sentence", "mechanics"];
export const SEVERITIES: Severity[] = ["must", "should", "consider"];

export interface Link {
  label: string;
  target: string; // URL or workspace-relative path
  why: string;
}

export interface ProposedSource {
  source: string;
  supports: string;
  status: "held" | "to verify" | "missing";
}

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  section: string;
  paragraph: number;
}

export interface Example {
  example: string;
  principle: string;
}

export interface Comment {
  id: string;
  perspective: string;
  engine: EngineName;
  run_id: string;
  level: Level;
  severity: Severity;
  kind: Kind;
  anchor: Anchor | null; // null = document-level point
  scope: Scope;
  title: string;
  rationale: string;
  hint: string;
  links: Link[];
  proposed_source: ProposedSource | null;
  example: Example | null;
  status: "open" | "resolved" | "dismissed";
  dismiss_reason: string | null;
  closed_at?: string | null; // when it was resolved or dismissed
  stale: boolean;
  flags: string[]; // e.g. "tell", "trimmed", "fuzzy"
  created: string;
}

/** What a model returns (agent-output.schema.json). */
export interface ModelComment {
  exact: string;
  prefix: string;
  suffix: string;
  title: string;
  rationale: string;
  hint: string;
  severity: Severity;
  level: Level;
  kind: Kind;
  links: Link[];
  proposed_source: ProposedSource | null;
}

export interface DocPoint {
  title: string;
  rationale: string;
  hint: string;
  severity: Severity;
  level: Level;
}

export interface AgentOutput {
  summary: string;
  doc_points: DocPoint[];
  comments: ModelComment[];
}

export interface Sidecar {
  version: 1;
  file_hash: string;
  comments: Comment[];
  summaries: Record<string, { summary: string; run_id: string; engine: EngineName; at: string }>;
  dropped: Record<string, number>; // run_id -> comments dropped (absent quote or guard)
}

export interface PerspectiveMeta {
  id: string;
  name: string;
  colour: string;
  level: Level;
  scopes: Scope[];
  default_scope: Scope;
  engine: EngineName;
  engine_release2?: EngineName;
  tools: string[];
  max_comments: number;
  max_comments_document?: number; // a higher cap for whole-draft runs
  needs: string[];
  profile_files: string[]; // keys of profile entries to include in the prompt
  shortcut: number;
  release: number;
  runnable?: boolean; // false: comments arrive another way (Word import, Jev), nothing to run
  note?: string; // shown at the top of the tab when there is no Run bar
}

export interface ArticleContext {
  title?: string;
  format?: string;
  purpose?: string;
  key_claim?: string;
  audience?: string;
  frame?: string; // geographic or institutional frame, e.g. "Australian"; "International with Australia as the worked example"
  reader_persona?: string;
  sceptic?: string;
  publication?: string;
  voice?: string; // a key from the profile's voices
  co_authors?: string[];
  length_target?: number;
  deadline?: string;
  reference_folders?: string[];
  sources_file?: string;
  positions_relevant?: string[];
  sensitivity?: Array<"partnership" | "standards" | "paid-newsletters" | "embargo">;
  exemplars?: string[];
  notes?: string;
}

export interface RunRequest {
  path: string;
  perspective: string;
  scope: Scope;
  engine?: EngineName;
  // Character offsets into the current text for selection, paragraph or section scope.
  from?: number;
  to?: number;
  text: string; // the editor buffer at run time
  mode?: "review" | "example";
  comment_id?: string; // example mode
}

export type RunEvent =
  | { type: "run-start"; run_id: string; perspective: string; engine: EngineName; scope: Scope; path: string }
  | { type: "run-end"; run_id: string; perspective: string; ok: boolean; message: string; added: number; dropped: number; secs: number; path: string }
  | { type: "file-changed"; path: string; hash: string }
  | { type: "comments-changed"; path: string };
