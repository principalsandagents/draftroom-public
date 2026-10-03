import { describe, expect, it } from "vitest";
import { claudeArgv } from "../server/engines/claude.ts";
import { codexArgv } from "../server/engines/codex.ts";
import { cleanEnv } from "../server/engines/pool.ts";
import { parseTellLint } from "../server/engines/lint.ts";

describe("argv builders", () => {
  it("Claude review runs are read-only and isolated", () => {
    const a = claudeArgv({ schema: {}, tools: ["Read", "Grep", "Glob", "Bash", "Write"], addDirs: ["/x/refs"], web: false });
    expect(a).toContain("--safe-mode");
    expect(a).toContain("--restricted");
    expect(a).toContain("--strict-mcp-config");
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(a).toContain("--add-dir=/x/refs");
    expect(a).not.toContain("--bare");
    expect(a.join(" ")).not.toMatch(/dangerously/);
  });
  it("the Claude web pass has web tools and no file tools or folders", () => {
    const a = claudeArgv({ schema: {}, tools: ["Read", "Grep", "Glob"], addDirs: ["/x/refs"], web: true });
    expect(a[a.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(a.some((x) => x.startsWith("--add-dir"))).toBe(false);
  });
  it("Codex never searches and never gets --add-dir", () => {
    const a = codexArgv({ runDir: "/tmp/run" });
    expect(a).not.toContain("--search");
    expect(a).not.toContain("--add-dir");
    expect(a).toContain("--ignore-user-config");
    expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(a[a.indexOf("-C") + 1]).toBe("/tmp/run");
  });
  it("spawned environments carry no API keys", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const env = cleanEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
});

describe("tell-lint output parser", () => {
  it("reads fails and warnings", () => {
    const out = "stdin:\n  [stock-connector] line 1: Moreover, this works.\nwarnings (not blocking):\n  [hedge] line 3: ...might perhaps...\n";
    const hits = parseTellLint(out);
    expect(hits).toEqual([
      { rule: "stock-connector", tier: "fail", line: 1, excerpt: "Moreover, this works." },
      { rule: "hedge", tier: "warn", line: 3, excerpt: "...might perhaps..." },
    ]);
  });
});
