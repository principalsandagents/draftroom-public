// Citations Release C: lookups, details, claims, retrieval, judgement with passage check.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox } from "./helpers.ts";
import { titleSimilarity, invertedToText, compareDetails, crossref, setLookupFetch } from "../server/cite/lookup.ts";

const sb = sandbox();
process.env.DRAFTROOM_HOME = sb.home;

describe("lookups", () => {
  it("compares titles without subtitles or punctuation", () => {
    expect(titleSimilarity("Highly Accurate Protein Structure Prediction with AlphaFold", "Highly accurate protein structure prediction with AlphaFold: a review")).toBeGreaterThan(0.9);
    expect(titleSimilarity("Accurate Protein Folding with AlphaFold", "Highly accurate protein structure prediction with AlphaFold")).toBeLessThan(0.9);
  });
  it("rebuilds an OpenAlex abstract from its inverted index", () => {
    expect(invertedToText({ Proteins: [0], fold: [1], quickly: [2] })).toBe("Proteins fold quickly");
  });
  it("lists the details that differ", () => {
    const d = compareDetails({ type: "article-journal", title: "Accurate Protein Folding with AlphaFold", year: 2019, authors: [{ family: "Jumper" }] }, { source: "crossref", title: "Highly accurate protein structure prediction with AlphaFold", authors: ["Jumper", "Evans"], year: 2021, similarity: 0.7 });
    expect(d.join(" ")).toMatch(/title in note/);
    expect(d.join(" ")).toMatch(/year in note 2019, crossref 2021/);
  });
  it("sends the contact email only to the scholarly hosts, with no draft text", async () => {
    const seen: Array<{ url: string; ua: string }> = [];
    setLookupFetch((async (u: any, init: any) => { seen.push({ url: String(u), ua: init.headers["user-agent"] }); return new Response(JSON.stringify({ message: { items: [] } })); }) as any);
    await crossref({ type: "report", title: "The State of Widget Governance", year: 2023 }, "writer@example.org");
    expect(seen[0].url).toMatch(/^https:\/\/api\.crossref\.org\/works\?query\.bibliographic=/);
    expect(seen[0].ua).toContain("mailto:writer@example.org");
    expect(seen[0].url).not.toMatch(/claim|draft/i);
    setLookupFetch(null);
  });
});

describe("claims and passages", () => {
  it("takes the sentence a note follows, seeing through note labels", async () => {
    const { claimFor } = await import("../server/cite/verify.ts");
    const t = "<!-- body -->\n\nProtein structure prediction reached near-experimental accuracy for many proteins in a community assessment.[^FN01-aaaa] A later paper showed that models now write novels unaided.[^FN02-bbbb]\n\n[^FN01-aaaa]: x\n\n[^FN02-bbbb]: y\n";
    expect(claimFor(t, "FN01-aaaa")!.claim).toBe("Protein structure prediction reached near-experimental accuracy for many proteins in a community assessment.");
    expect(claimFor(t, "FN02-bbbb")!.claim).toMatch(/^Protein structure prediction.*A later paper showed that models now write novels unaided\.$/); // short sentence takes the one before
  });
  it("retrieves the passages that share the claim's words", async () => {
    const { retrievePassages } = await import("../server/cite/verify.ts");
    const filler = "Unrelated text about weather and gardens. ".repeat(80);
    const src = `${filler} The system reached near-experimental accuracy on most targets in the CASP14 assessment of protein structure prediction. ${filler}`;
    const ps = retrievePassages(src, "Protein structure prediction reached near-experimental accuracy in a community assessment.");
    expect(ps[0]).toContain("near-experimental accuracy");
  });
});

describe("validation with fakes", () => {
  it("sets aside a judgement whose quoted passage is not in the source", async () => {
    const runs = await import("../server/runs.ts");
    const { validateReferences } = await import("../server/cite/verify.ts");
    const { readCiteState } = await import("../server/cite/state.ts");
    const { loadProfile } = await import("../server/profile.ts");
    const fetchMod = await import("../server/cite/fetch.ts");
    runs.initHome();
    const page = `<html><head><title>Report on agents</title></head><body><main><p>${"Background on testing environments for AI systems. ".repeat(40)}</p><p>The agent escaped its sandbox during testing and reached external systems.</p></main></body></html>`;
    fetchMod.setFetchForTests((async () => new Response(page, { headers: { "content-type": "text/html" } })) as any, async () => ["93.184.216.34"]);
    const text = "<!-- body -->\n\nThe agent escaped its sandbox during testing and reached external systems, according to the report.[^FN01-aaaa]\n\n<!-- Footnotes -->\n\n[^FN01-aaaa]: https://example.org/report\n";
    fs.writeFileSync(sb.draft, text);
    let call = 0;
    runs.engines.claude = async (i: any) => {
      call++;
      if (i.prompt.includes("Notes to read")) return { output: { notes: [{ label: "FN01-aaaa", segments: [{ kind: "citation", text: "https://example.org/report", sources: [{ type: "webpage", url: "https://example.org/report" }] }] }] }, secs: 1, raw: "" };
      expect(i.prompt).toContain("The agent escaped its sandbox");
      return { output: { relevance: "relevant", support: "supported", reason: "It says so.", passage: "The agent was shut down by its developers before reaching anything." }, secs: 1, raw: "" };
    };
    const prof = { ...loadProfile(sb.profPath), library_dir: path.join(sb.root, "lib"), contact_email: undefined };
    const r = await validateReferences(prof, sb.draft, text);
    expect(r.sources).toBe(1);
    const v = (readCiteState(sb.draft) as any).validation.aaaa.sources[0];
    expect(v.exists.status).toBe("url_answers");
    expect(v.fulltext.status).toBe("saved");
    expect(v.support.status).toBe("not_verified");
    expect(v.support.passage_verified).toBe(false);
    expect(call).toBe(2);
    fetchMod.setFetchForTests(null);
  });
});
