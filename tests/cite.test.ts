// Citations Release A: quotes, matching, the safe fetcher, the library, linking, anchors.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sandbox } from "./helpers.ts";
import { findQuotes, matchQuote, noteUrl, quotePieces } from "../server/cite/quotes.ts";
import { fetchSource, setFetchForTests, deniedDomain } from "../server/cite/fetch.ts";

const sb = sandbox();
process.env.DRAFTROOM_HOME = sb.home;

const SOURCE_HTML = `<html><head><title>Security incident July 2026</title></head><body><nav>Home About Blog Pricing</nav><main><h1>Incident</h1><p>${"Background text about the platform and its users. ".repeat(30)}</p><p>Our investigation found the intrusion was driven, end to end, by an autonomous AI agent system that probed our infrastructure for several days. We did not detect it at first.</p><p>${"More background on remediation and next steps for the community. ".repeat(20)}</p></main><footer>Copyright</footer></body></html>`;

const DRAFT = `---
title: Quote test
---

<!-- body -->

The breach “was driven, end to end, by an autonomous AI agent system".[^FN01-9w7f] It went on for days.

A later report said the attack “was led, start to finish, by a human team" according to one account.[^FN01-9w7f]

Another claim said the company “did detect it at first" which is not what they wrote.[^FN01-9w7f]

A quote with “no source attached to it anywhere at all" sits here.

<!-- Footnotes -->

[^FN01-9w7f]: https://huggingface.co/blog/security-incident-july-2026
`;

function fakeWeb(pages: Record<string, { status?: number; body: string; type?: string; location?: string }>) {
  setFetchForTests((async (u: any) => {
    const url = String(u);
    const p = pages[url];
    if (!p) return new Response("not found", { status: 404 });
    const headers: Record<string, string> = { "content-type": p.type ?? "text/html" };
    if (p.location) headers.location = p.location;
    return new Response(p.body, { status: p.status ?? 200, headers });
  }) as any, async (h) => (h === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"]));
}

describe("finding quotes", () => {
  it("finds quotes with mixed curly and straight marks and ties each to its note", () => {
    const q = findQuotes(DRAFT);
    expect(q.map((x) => x.quote)).toContain("was driven, end to end, by an autonomous AI agent system");
    expect(q.find((x) => x.quote.startsWith("was driven"))!.labels).toEqual(["FN01-9w7f"]);
    expect(q.find((x) => x.quote.startsWith("no source"))!.labels).toEqual([]);
  });
  it("reads the note's web address", () => {
    expect(noteUrl("See: https://example.org/report.pdf.")).toBe("https://example.org/report.pdf");
  });
});

describe("matching", () => {
  const src = "Our investigation found the intrusion was driven, end to end, by an autonomous AI agent system that probed. We did not detect it at first. The rate rose by 12 per cent.";
  it("exact ignores quote marks, case and spacing", () => {
    expect(matchQuote("Was driven,  end to end, by an autonomous AI agent system", src).status).toBe("exact");
  });
  it("handles ellipses and bracketed alterations as gaps", () => {
    expect(quotePieces("the intrusion was driven … by an autonomous AI agent [system]")).toHaveLength(2);
    expect(matchQuote("the intrusion was driven … by an autonomous AI agent", src).status).toBe("exact");
  });
  it("calls a one-word slip close, with the differing word", () => {
    const m = matchQuote("the intrusion was driven, end to end, by an automated AI agent system", src);
    expect(m.status).toBe("close");
    expect(m.differs).toContain("automated");
  });
  it("fails when a negation or a number differs, however close", () => {
    expect(matchQuote("We did detect it at first", src).status).toBe("not_found");
    expect(matchQuote("The rate rose by 15 per cent", src).status).toBe("not_found");
  });
  it("reports not found for a quote that is not there", () => {
    expect(matchQuote("was led, start to finish, by a human team", src).status).toBe("not_found");
  });
});

describe("safe fetching", () => {
  it("refuses private addresses, file URLs and redirects into the network", async () => {
    fakeWeb({ "https://public.example/r": { status: 302, body: "", location: "https://internal.example/secret" } });
    expect((await fetchSource("https://internal.example/x")) as any).toMatchObject({ ok: false, reason: expect.stringMatching(/inside this computer/) });
    expect((await fetchSource("file:///etc/passwd")) as any).toMatchObject({ ok: false });
    expect((await fetchSource("https://public.example/r")) as any).toMatchObject({ ok: false, reason: expect.stringMatching(/inside this computer/) });
  });
  it("never fetches paid newsletters or standards stores", async () => {
    let called = false;
    setFetchForTests((async () => { called = true; return new Response("x"); }) as any, async () => ["93.184.216.34"]);
    const r: any = await fetchSource("https://www.exponentialview.co/p/some-issue");
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
    expect(called).toBe(false);
    expect(deniedDomain("store.standards.org.au", ["standards.org.au"])).toBe("standards.org.au");
  });
  it("reports short or blocked pages as not checked", async () => {
    fakeWeb({ "https://x.example/a": { body: "<html><body>Enable JavaScript</body></html>" }, "https://x.example/b": { status: 403, body: "" } });
    expect(((await fetchSource("https://x.example/a")) as any).reason).toMatch(/only \d+ words/);
    expect(((await fetchSource("https://x.example/b")) as any).reason).toMatch(/refused access/);
  });
  it("extracts main text from HTML without navigation", async () => {
    fakeWeb({ "https://huggingface.co/blog/security-incident-july-2026": { body: SOURCE_HTML } });
    const r: any = await fetchSource("https://huggingface.co/blog/security-incident-july-2026");
    expect(r.ok).toBe(true);
    expect(r.title).toBe("Security incident July 2026");
    expect(r.text).toContain("driven, end to end");
    expect(r.text).not.toContain("Pricing");
  });
});

describe("quote check end to end", () => {
  let check: typeof import("../server/cite/check.ts");
  let profile: typeof import("../server/profile.ts");
  let store: typeof import("../server/store.ts");
  let state: typeof import("../server/cite/state.ts");
  const lib = path.join(sb.root, "library");
  beforeAll(async () => {
    check = await import("../server/cite/check.ts");
    profile = await import("../server/profile.ts");
    store = await import("../server/store.ts");
    state = await import("../server/cite/state.ts");
    fs.writeFileSync(sb.draft, DRAFT);
  });
  const prof = () => ({ ...profile.loadProfile(sb.profPath), library_dir: lib });
  it("fetches the source once, saves it to the library, and records each quote", async () => {
    fakeWeb({ "https://huggingface.co/blog/security-incident-july-2026": { body: SOURCE_HTML } });
    const r = await check.checkQuotes(prof(), sb.draft, DRAFT);
    expect(r).toMatchObject({ quotes: 4, exact: 1, not_found: 2, not_checked: 1 });
    const cards = fs.readdirSync(path.join(lib, "cards"));
    expect(cards).toHaveLength(1);
    const card = fs.readFileSync(path.join(lib, "cards", cards[0]), "utf8");
    expect(card).toContain("Security incident July 2026");
    expect(card).toMatch(/\| quote \| exact \|/);
    expect(card).not.toContain(path.basename(sb.draft));
    expect(fs.readdirSync(path.join(lib, "files"))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(lib, "index", "cited-by.json"), "utf8"))[cards[0].replace(/\.md$/, "")]).toEqual([sb.draft]);
    const comments = store.readSidecar(sb.draft).comments.filter((c) => c.engine === "cite");
    expect(comments.map((c) => c.title).sort()).toEqual(["Quote not checked against a source", "Quote not found in the source", "Quote not found in the source"]);
    expect(check.verifiedQuotesForPrompt(sb.draft)[0]).toMatch(/was driven, end to end/);
  });
  it("reuses the library copy without fetching again", async () => {
    let fetched = false;
    setFetchForTests((async () => { fetched = true; return new Response("x"); }) as any, async () => ["93.184.216.34"]);
    await check.checkQuotes(prof(), sb.draft, DRAFT);
    expect(fetched).toBe(false);
  });
  it("links a file to a note and refuses copies of denied material", async () => {
    const txt = Buffer.from("Interview notes. " + "The attack was led, start to finish, by a human team according to the engineer. ".repeat(3));
    const r = await check.linkFile(prof(), sb.draft, "FN01-9w7f", "interview-notes.txt", txt);
    expect(r.id).toMatch(/^linked-interview-notes-/);
    expect(state.readCiteState(sb.draft).links["9w7f"]).toBe(r.id);
    const after = await check.checkQuotes(prof(), sb.draft, DRAFT);
    expect(after.exact).toBe(1); // now matched against the linked notes, where the "human team" quote appears
    const denied = path.join(sb.root, "denied");
    fs.mkdirSync(denied, { recursive: true });
    fs.writeFileSync(path.join(denied, "standard.pdf"), "LICENSED STANDARD TEXT");
    const p = { ...prof(), denied_paths: [denied] };
    await expect(check.linkFile(p, sb.draft, "FN01-9w7f", "copy.txt", Buffer.from("LICENSED STANDARD TEXT"))).rejects.toThrow(/must not store/);
  });
});

describe("comments follow renumbered notes", () => {
  it("re-anchors a comment on a note definition after its number changes", async () => {
    const store = await import("../server/store.ts");
    const t1 = "A.[^FN01-aaaa] B.[^FN02-bbbb]\n\n<!-- Footnotes -->\n\n[^FN01-aaaa]: First.\n\n[^FN02-bbbb]: OpenAI, 14 September 2026\n";
    const exact = "[^FN02-bbbb]: OpenAI, 14 September 2026";
    const start = t1.indexOf(exact);
    const c: any = { id: "x", perspective: "evidence", engine: "claude", run_id: "r", level: "argument", severity: "should", kind: "check", anchor: { exact, prefix: t1.slice(start - 20, start), suffix: "", start, end: start + exact.length, section: "", paragraph: 0 }, scope: "document", title: "t", rationale: "r", hint: "h", links: [], proposed_source: null, example: null, status: "open", dismiss_reason: null, stale: false, flags: [], created: "" };
    const t2 = "Z.[^FN01-cccc] A.[^FN02-aaaa] B.[^FN03-bbbb]\n\n<!-- Footnotes -->\n\n[^FN01-cccc]: New.\n\n[^FN02-aaaa]: First.\n\n[^FN03-bbbb]: OpenAI, 14 September 2026\n";
    const sc: any = store.reanchorAll({ version: 1, file_hash: "", comments: [c], summaries: {}, dropped: {} }, t2);
    expect(sc.comments[0].stale).toBe(false);
    expect(t2.slice(sc.comments[0].anchor.start, sc.comments[0].anchor.end)).toBe("[^FN03-bbbb]: OpenAI, 14 September 2026");
  });
});

describe("Jev citation detector", () => {
  it("recognises author-date citations with ampersands and pinpoints", async () => {
    const { eligibleParagraphs } = await import("../server/jev/select.ts");
    const para = (cite: string) => `Boards approved many new uses of AI last year across the sector, and few were reviewed formally ${cite}. That gap is where the risk sits for directors who approve them without seeing the detail.`;
    for (const c of ["(Smith & Jones, 2020)", "(OECD, 2024, p. 4)", "(see Okafor 2023)"]) {
      expect(eligibleParagraphs(`<!-- body -->\n\n${para(c)}\n`)[0].has_citation).toBe(true);
    }
  });
});
