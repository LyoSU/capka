import { writeFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

import type { GenerateFn } from "@/lib/vault/extract";
import { checkJudge, makeJudge } from "./judge";
import { crossLanguagePairs, runTopicReuse, summarize, TOPIC_INSTRUCTION } from "./topic-reuse";
import { loadCorpus } from "./types";

/**
 * Does the model reuse an existing topic, or mint a new name every turn?
 *
 * Opt-in, because it spends real money at a real provider — 54 sequential calls, plus the
 * judge's control:
 *
 *   RUN_VAULT_EVAL=1 \
 *   VAULT_EVAL_BASE_URL=https://api.example.com/v1 \
 *   VAULT_EVAL_API_KEY=... \
 *   VAULT_EVAL_MODEL=some-model \
 *   VAULT_EVAL_TOPIC_REPORT=/tmp/topic-reuse.md \
 *   npx vitest run src/lib/vault/eval/topic-reuse.eval.test.ts
 *
 * Same seam as the extraction eval and for the same reasons: OpenAI-compatible, model from the
 * environment rather than `auxGenerate` (which would read the installation's catalog out of the
 * database and spend the operator's own key), and no database access of any kind.
 *
 * This file sets NO pass/fail threshold. A threshold chosen before a baseline exists either
 * blocks every run or waves every one through, and choosing it afterwards to make a run pass is
 * how a gate becomes a formality. It reports numbers; the decision is a person's.
 */
const run = process.env.RUN_VAULT_EVAL ? describe : describe.skip;

const BASE_URL = process.env.VAULT_EVAL_BASE_URL ?? "";
const API_KEY = process.env.VAULT_EVAL_API_KEY ?? "";
const MODEL = process.env.VAULT_EVAL_MODEL ?? "";
const JUDGE_MODEL = process.env.VAULT_EVAL_JUDGE_MODEL ?? MODEL;
const REPORT = process.env.VAULT_EVAL_TOPIC_REPORT;

/** Mirrors the extraction eval's local helper. Kept local there and here rather than shared:
 *  both are eight lines of provider wiring, and exporting one test file's internals into another
 *  buys nothing this directory needs. */
function generatorFor(modelId: string): GenerateFn {
  const provider = createOpenAICompatible({ name: "vault-eval", baseURL: BASE_URL, apiKey: API_KEY });
  const model = provider(modelId);
  return async ({ system, prompt, maxOutputTokens }) => {
    const r = await generateText({ model, system, prompt, maxOutputTokens });
    return { text: r.text, finishReason: r.finishReason };
  };
}

const ratio = (n: number | null) => (n === null ? "n/a" : n.toFixed(3));

run("topic reuse", () => {
  it("is measured by running the corpus in sequence from an empty topic list", async () => {
    for (const [name, v] of [["VAULT_EVAL_BASE_URL", BASE_URL], ["VAULT_EVAL_API_KEY", API_KEY], ["VAULT_EVAL_MODEL", MODEL]]) {
      if (!v) throw new Error(`${name} is required when RUN_VAULT_EVAL is set`);
    }

    const corpus = loadCorpus();

    // The measured run goes FIRST, unlike the extraction eval. There the judge decides every
    // number, so a failed control is terminal; here it decides only the cross-language section,
    // and spending 54 calls and then discarding the headline ratio because a secondary
    // instrument was unwell would throw away the answer that was actually paid for.
    const result = await runTopicReuse({ corpus, generate: generatorFor(MODEL) });
    const s = summarize(result);

    // Same rule the extraction eval holds, applied where it belongs: a judge that says "same
    // subject" to everything reports a flattering cross-language number and nothing about that
    // number gives it away. If it cannot answer questions whose answers are known, this section
    // reports no number at all.
    const judge = makeJudge(generatorFor(JUDGE_MODEL));
    const control = await checkJudge(judge, corpus);
    const pairs = control.ok ? await crossLanguagePairs(result.topics, judge) : [];

    const boundCount = new Map<string, number>();
    for (const r of result.rows) {
      const o = r.outcome;
      if (o.kind === "reuse" || o.kind === "mint" || o.kind === "collision") {
        boundCount.set(o.topicId, (boundCount.get(o.topicId) ?? 0) + 1);
      }
    }

    const langRows = Object.entries(s.byLang).map(
      ([l, c]) => `| ${l} | ${c.turns} | ${c.reuse} | ${c.mint} | ${c.collision} | ${c.none} | ${c.malformed} |`,
    );

    const lines = [
      `# Topic reuse eval`,
      ``,
      `model: \`${MODEL}\`  ·  judge: \`${JUDGE_MODEL}\`  ·  ${new Date().toISOString()}`,
      ``,
      `Corpus run in sequence from an EMPTY topic list; the list on turn N is what the model's own`,
      `decisions built over turns 1..N-1.`,
      ``,
      `| metric | value |`,
      `| --- | --- |`,
      `| turns | ${s.counts.turns} |`,
      `| final topics | ${s.topicCount} |`,
      `| labelled facts in corpus | ${s.facts} |`,
      `| facts on filed turns | ${s.factsFiled} |`,
      `| **topics per fact** | ${ratio(s.topicsPerFact)} |`,
      `| topics per filed fact | ${ratio(s.topicsPerFiledFact)} |`,
      `| facts per topic | ${ratio(s.factsPerTopic)} |`,
      ``,
      `1.000 topics per fact means one topic per fact and a worthless mechanism. Claude.ai's own`,
      `memory at comparable scale sits near 0.100 (about ten facts per topic).`,
      ``,
      `| outcome | count |`,
      `| --- | --- |`,
      `| reuse | ${s.counts.reuse} |`,
      `| clean mint | ${s.counts.mint} |`,
      `| collision (minted a name it already held) | ${s.counts.collision} |`,
      `| none | ${s.counts.none} (${s.noneOnFactBearing} on turns that carried facts) |`,
      `| malformed | ${s.counts.malformed} |`,
      ``,
      ...(s.counts.malformed
        ? [
            `Malformed breakdown: ` +
              Object.entries(s.byMalformedReason)
                .filter(([, n]) => n)
                .map(([k, n]) => `${k} ${n}`)
                .join(", "),
            ``,
          ]
        : []),
      `## By language`,
      ``,
      `| lang | turns | reuse | mint | collision | none | malformed |`,
      `| --- | --- | --- | --- | --- | --- | --- |`,
      ...langRows,
      ``,
      `## Final topic list, in creation order`,
      ``,
      ...(result.topics.length
        ? result.topics.map((t) => `${t.id}. ${t.name}  —  minted by \`${t.mintedBy}\`, ${boundCount.get(t.id) ?? 0} turn(s) filed`)
        : ["(none minted)"]),
      ``,
      `## Accumulation curve`,
      ``,
      `Topic count after each turn: ${result.curve.join(", ")}`,
      ``,
      `## Cross-language pairs`,
      ``,
      `judge control: ${control.detail}`,
      ...(control.ok
        ? [
            ``,
            `The judge grades FACTS in its control and NAMES here, so read this as indicative.`,
            ``,
            ...(pairs.length
              ? pairs.map((p) => `- \`${p.cyrillic.id}\` ${p.cyrillic.name}  ≡  \`${p.latin.id}\` ${p.latin.name}`)
              : ["- none found"]),
          ]
        : [``, `**No cross-language number is reported**: the judge failed its own control, and a`, `flattering number from an untrustworthy instrument is worse than no number.`]),
      ``,
      `## Per-turn`,
      ``,
      ...result.rows.map((r, i) => {
        const o = r.outcome;
        const what =
          o.kind === "malformed"
            ? `malformed (${o.reason})${o.raw ? ` — ${JSON.stringify(o.raw)}` : ""}`
            : o.kind === "none"
              ? "none"
              : o.kind === "reuse"
                ? `reuse ${o.topicId}`
                : `${o.kind} ${o.topicId} "${o.name}"`;
        return `- ${String(i + 1).padStart(2, "0")} \`${r.id}\` (${r.lang}, ${r.facts} facts) → ${what}`;
      }),
      ``,
    ];
    const report = lines.join("\n");
    if (REPORT) writeFileSync(REPORT, report);
    console.log(report);

    // A harness check, not a quality gate: every fixture must have produced a decision, or the
    // ratio above is computed over a corpus that silently shrank.
    expect(result.rows).toHaveLength(corpus.length);
  }, 30 * 60_000);
});

// A skipped `describe` still evaluates this module, so the instrument is at least present in
// every ordinary test run — a prompt constant that stopped existing would fail here rather than
// in the maintainer's paid run.
describe("the instrument", () => {
  it("asks for the three-arm answer and warns the model not to invent an id", () => {
    expect(TOPIC_INSTRUCTION).toContain('{"kind":"existing","topicId":"<id>"}');
    expect(TOPIC_INSTRUCTION).toContain('{"kind":"new","name":"<display name>"}');
    expect(TOPIC_INSTRUCTION).toContain('{"kind":"none"}');
    expect(TOPIC_INSTRUCTION).toContain("never invent one");
  });
});
