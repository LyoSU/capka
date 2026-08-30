import { writeFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

import { extractFromTurn, type ExtractedItem, type GenerateFn } from "@/lib/vault/extract";
import { checkJudge, makeJudge } from "./judge";
import { aggregate, scoreFixture, type FixtureScore } from "./score";
import { loadCorpus, type Fixture } from "./types";

/**
 * How well does extraction actually work?
 *
 * Opt-in, because it spends real money at a real provider:
 *
 *   RUN_VAULT_EVAL=1 \
 *   VAULT_EVAL_BASE_URL=https://api.example.com/v1 \
 *   VAULT_EVAL_API_KEY=... \
 *   VAULT_EVAL_MODEL=some-model \
 *   npx vitest run src/lib/vault/eval
 *
 * It speaks OpenAI-compatible and takes its model from the environment rather than going
 * through `auxGenerate`, on purpose. `auxGenerate` reads the installation's model catalog
 * out of the database, which would tie a measurement to one deployment's configuration and
 * make it impossible to score a model this installation has not adopted — which is exactly
 * what you want to do before adopting one. Nothing here touches the database.
 *
 * `VAULT_EVAL_JUDGE_MODEL` defaults to the same model. Scoring with the model under test is
 * a conflict of interest worth avoiding when you can, but the control below is what decides
 * whether any judge is trustworthy, and it applies the same either way.
 */
const run = process.env.RUN_VAULT_EVAL ? describe : describe.skip;

const BASE_URL = process.env.VAULT_EVAL_BASE_URL ?? "";
const API_KEY = process.env.VAULT_EVAL_API_KEY ?? "";
const MODEL = process.env.VAULT_EVAL_MODEL ?? "";
const JUDGE_MODEL = process.env.VAULT_EVAL_JUDGE_MODEL ?? MODEL;
const REPORT = process.env.VAULT_EVAL_REPORT;

/** Turns in flight at once. The corpus is small and providers rate-limit; four keeps a
 *  full run to a couple of minutes without turning the measurement into a load test. */
const CONCURRENCY = 4;

function generatorFor(modelId: string): GenerateFn {
  const provider = createOpenAICompatible({ name: "vault-eval", baseURL: BASE_URL, apiKey: API_KEY });
  const model = provider(modelId);
  return async ({ system, prompt, maxOutputTokens }) => {
    const r = await generateText({ model, system, prompt, maxOutputTokens });
    return { text: r.text, finishReason: r.finishReason };
  };
}

/** Run `worker` over `items`, at most `limit` at a time, preserving order. */
async function pooled<T, R>(items: T[], limit: number, worker: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);

run("extraction quality", () => {
  it("is measured against the labelled corpus", async () => {
    for (const [name, v] of [["VAULT_EVAL_BASE_URL", BASE_URL], ["VAULT_EVAL_API_KEY", API_KEY], ["VAULT_EVAL_MODEL", MODEL]]) {
      if (!v) throw new Error(`${name} is required when RUN_VAULT_EVAL is set`);
    }

    const corpus = loadCorpus();
    const judge = makeJudge(generatorFor(JUDGE_MODEL));

    // The control runs FIRST and its failure is terminal. A judge that says "matched" to
    // everything reports a flawless score, and nothing about that number gives it away —
    // so a run that cannot vouch for its own instrument must report no number at all
    // rather than a flattering one.
    const control = await checkJudge(judge, corpus);
    // eslint-disable-next-line no-console
    console.log(`judge control: ${control.detail}`);
    expect(control.ok, `judge is not trustworthy, so no score was computed — ${control.detail}`).toBe(true);

    const extract = generatorFor(MODEL);
    type Row = { fixture: Fixture; items: ExtractedItem[]; failure: string | null; score: FixtureScore | null };

    const rows = await pooled(corpus, CONCURRENCY, async (fixture): Promise<Row> => {
      const outcome = await extractFromTurn({
        userText: fixture.user,
        assistantText: fixture.assistant,
        generate: extract,
      });
      if (!outcome.ok) return { fixture, items: [], failure: outcome.reason, score: null };

      // Holes are the extractor's own malformed entries. They are dropped for SCORING —
      // an entry with no statement asserts nothing either way — and counted separately,
      // because a rising hole count is a format problem wearing a quality problem's face.
      const items = outcome.items.filter((x): x is ExtractedItem => !!x);
      const mappings = await judge({
        expected: fixture.expect.map((e) => e.gist),
        forbid: fixture.forbid,
        extracted: items.map((x) => x.statement),
      });
      return { fixture, items, failure: null, score: scoreFixture(fixture, items, mappings) };
    });

    const failures = rows.filter((r) => r.failure);
    const scores = rows.map((r) => r.score).filter((s): s is FixtureScore => !!s);
    const agg = aggregate(scores);

    const lines = [
      `# Extraction eval`,
      ``,
      `model: \`${MODEL}\`  ·  judge: \`${JUDGE_MODEL}\`  ·  ${new Date().toISOString()}`,
      `judge control: ${control.detail}`,
      ``,
      `| metric | value |`,
      `| --- | --- |`,
      `| turns scored | ${agg.turns} of ${corpus.length} |`,
      `| macro F0.5 | ${pct(agg.macroF)} |`,
      `| macro precision | ${pct(agg.macroPrecision)} |`,
      `| macro recall | ${pct(agg.macroRecall)} |`,
      `| scope accuracy | ${pct(agg.scopeAccuracy)} |`,
      `| sensitive accuracy | ${pct(agg.sensitiveAccuracy)} |`,
      `| unreadable replies | ${failures.length} |`,
      ``,
      `## By language`,
      ``,
      `| lang | turns | macro F0.5 |`,
      `| --- | --- | --- |`,
      ...Object.entries(agg.byLang).map(([l, v]) => `| ${l} | ${v.turns} | ${pct(v.macroF)} |`),
      ``,
      `## Worst turns`,
      ``,
      ...[...scores]
        .sort((a, b) => a.f - b.f)
        .slice(0, 12)
        .map((s) => `- \`${s.id}\` F=${pct(s.f)} — wanted ${s.expected}, got ${s.extracted}, covered ${s.covered}, noise ${s.noise}`),
      ``,
      `## Safety`,
      ``,
      ...(agg.safetyFailures.length ? agg.safetyFailures.map((f) => `- ${f}`) : ["- none"]),
      ...(failures.length ? [``, `## Unreadable`, ``, ...failures.map((f) => `- \`${f.fixture.id}\`: ${f.failure}`)] : []),
      ``,
    ];
    const report = lines.join("\n");
    if (REPORT) writeFileSync(REPORT, report);
    // eslint-disable-next-line no-console
    console.log(report);

    // The only hard gate this file asserts. Everything else is a number to compare against
    // the last run — a threshold picked before there is a baseline would either block every
    // release or wave every one through, and choosing it afterwards to make a release pass
    // is how a gate becomes a formality.
    expect(agg.safetyFailures, "a credential or an injected instruction reached a stored fact").toEqual([]);
  }, 20 * 60_000);
});
