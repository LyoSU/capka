import { describe, it, expect } from "vitest";

import type { GenerateFn } from "@/lib/vault/extract";
import {
  buildTopicPrompt,
  parseChoice,
  runTopicReuse,
  summarize,
  TOPIC_INSTRUCTION,
  type Topic,
} from "../topic-reuse";
import { loadCorpus, type Fixture } from "../types";

// The topic-reuse harness's own arithmetic, verified without spending a single model call.
// The measured run needs a provider and a budget; the thing that turns its answers into a
// number does not — and this is the half that decides what the number MEANS, so a collision
// counted as a reuse, or a malformed id counted as a mint, would produce a well-formed
// answer to a question nobody asked.

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  id: "t",
  lang: "uk",
  why: "test",
  user: "u",
  assistant: "a",
  expect: [],
  forbid: [],
  ...over,
});

/** A generator that reads its replies off a script, one per call, and records every prompt it
 *  was given — so a test can assert on the instrument as well as on the answer. */
function scripted(replies: (string | { text?: string; finishReason?: string; throws?: true })[]) {
  const prompts: { system: string; prompt: string }[] = [];
  let n = 0;
  const generate: GenerateFn = async ({ system, prompt }) => {
    prompts.push({ system, prompt });
    const r = replies[n++] ?? "";
    if (typeof r === "string") return { text: r, finishReason: "stop" };
    if (r.throws) throw new Error("provider said no");
    return { text: r.text ?? "", finishReason: r.finishReason ?? "stop" };
  };
  return { generate, prompts };
}

const topic = (id: string, name: string): Topic => ({ id, name, mintedBy: "x" });

describe("parseChoice", () => {
  const held = [topic("t01", "Work")];

  it("reads the three legal shapes", () => {
    expect(parseChoice('{"kind":"none"}', held)).toEqual({ kind: "none" });
    expect(parseChoice('{"kind":"existing","topicId":"t01"}', held)).toEqual({ kind: "existing", topicId: "t01" });
    expect(parseChoice('{"kind":"new","name":"Budget"}', held)).toEqual({ kind: "new", name: "Budget" });
  });

  it("tolerates a code fence and surrounding prose, like the extractor's parser does", () => {
    expect(parseChoice('Sure!\n```json\n{"kind":"none"}\n```\n', held)).toEqual({ kind: "none" });
  });

  it("refuses an id it never handed out", () => {
    // The finding the whole measurement is built around: an invented id is a broken contract,
    // and reading it as "new" would erase exactly the failure being looked for.
    expect(parseChoice('{"kind":"existing","topicId":"t99"}', held)).toEqual({ bad: "unknown_id" });
  });

  it("separates the ways a reply can be unusable", () => {
    expect(parseChoice("no json here", held)).toEqual({ bad: "unparseable" });
    expect(parseChoice("{not json}", held)).toEqual({ bad: "unparseable" });
    expect(parseChoice('{"kind":"merge","topicId":"t01"}', held)).toEqual({ bad: "unknown_kind" });
    expect(parseChoice('{"kind":"new","name":"   "}', held)).toEqual({ bad: "empty_name" });
  });
});

describe("the prompt the model is given", () => {
  it("carries the accumulated list as id TAB name, and says (none) while empty", async () => {
    const { generate, prompts } = scripted(['{"kind":"new","name":"Tenders"}', '{"kind":"existing","topicId":"t01"}']);
    await runTopicReuse({ corpus: [fixture({ id: "a", user: "first" }), fixture({ id: "b", user: "second" })], generate });

    expect(prompts[0].system).toBe(TOPIC_INSTRUCTION);
    expect(prompts[0].prompt).toContain("<topics>\n(none)\n</topics>");
    expect(prompts[0].prompt).toContain("first");
    // Turn two sees what turn one minted — the accumulation that is the whole point.
    expect(prompts[1].prompt).toContain("<topics>\nt01\tTenders\n</topics>");
  });

  it("wraps both halves of the turn in tags", () => {
    const p = buildTopicPrompt(fixture({ user: "U", assistant: "A" }), [topic("t01", "Work")]);
    expect(p).toContain("<user_turn>\nU\n</user_turn>");
    expect(p).toContain("<assistant_turn>\nA\n</assistant_turn>");
  });
});

describe("runTopicReuse accounting", () => {
  it("counts a reuse as a reuse and grows nothing", async () => {
    const { generate } = scripted(['{"kind":"new","name":"Work"}', '{"kind":"existing","topicId":"t01"}']);
    const run = await runTopicReuse({ corpus: [fixture({ id: "a" }), fixture({ id: "b" })], generate });
    const s = summarize(run);
    expect(s.counts).toMatchObject({ turns: 2, reuse: 1, mint: 1, collision: 0, none: 0, malformed: 0 });
    expect(run.topics.map((t) => t.id)).toEqual(["t01"]);
  });

  it("counts a collision as a collision — never as a reuse, and never as a clean mint", async () => {
    // The model asked for a NEW subject and named one it was already holding. Calling that a
    // reuse would credit the model for a save the server's normalization made.
    const { generate } = scripted(['{"kind":"new","name":"Work"}', '{"kind":"new","name":"  WORK  "}']);
    const run = await runTopicReuse({ corpus: [fixture({ id: "a" }), fixture({ id: "b" })], generate });
    const s = summarize(run);
    expect(s.counts).toMatchObject({ reuse: 0, mint: 1, collision: 1 });
    expect(run.topics).toHaveLength(1);
    expect(run.rows[1].outcome).toEqual({ kind: "collision", topicId: "t01", name: "WORK" });
  });

  it("counts a malformed id as malformed only, and mints nothing from it", async () => {
    const { generate } = scripted(['{"kind":"new","name":"Work"}', '{"kind":"existing","topicId":"t42"}']);
    const run = await runTopicReuse({ corpus: [fixture({ id: "a" }), fixture({ id: "b" })], generate });
    const s = summarize(run);
    expect(s.counts).toMatchObject({ reuse: 0, mint: 1, collision: 0, none: 0, malformed: 1 });
    expect(s.byMalformedReason.unknown_id).toBe(1);
    expect(run.topics).toHaveLength(1);
  });

  it("keeps the malformed reasons apart", async () => {
    const { generate } = scripted([
      "not json at all",
      { finishReason: "length", text: '{"kind":"new","name":"trunc' },
      { throws: true },
      '{"kind":"new","name":""}',
    ]);
    const run = await runTopicReuse({
      corpus: [fixture({ id: "a" }), fixture({ id: "b" }), fixture({ id: "c" }), fixture({ id: "d" })],
      generate,
    });
    const s = summarize(run);
    expect(s.counts.malformed).toBe(4);
    expect(s.byMalformedReason).toMatchObject({
      unparseable: 1,
      truncated: 1,
      call_failed: 1,
      empty_name: 1,
    });
    // A dead provider on turn 3 must not cost the remaining turns: the run continues.
    expect(run.rows).toHaveLength(4);
  });

  it("splits `none` by whether the turn had anything to file", async () => {
    // Fourteen corpus fixtures exist to be answered with silence. Folding a correct refusal
    // together with a dropped fact would read the corpus's best behaviour as its worst.
    const { generate } = scripted(['{"kind":"none"}', '{"kind":"none"}']);
    const run = await runTopicReuse({
      corpus: [fixture({ id: "a", expect: [{ gist: "one" }] }), fixture({ id: "b" })],
      generate,
    });
    const s = summarize(run);
    expect(s.counts.none).toBe(2);
    expect(s.noneOnFactBearing).toBe(1);
    expect(s.noneOnEmpty).toBe(1);
  });

  it("computes the headline ratio over both denominators", async () => {
    // Two mints over four labelled facts, one of which sat on a turn the model declined to file.
    const { generate } = scripted([
      '{"kind":"new","name":"Work"}',
      '{"kind":"new","name":"Budget"}',
      '{"kind":"none"}',
    ]);
    const run = await runTopicReuse({
      corpus: [
        fixture({ id: "a", expect: [{ gist: "1" }, { gist: "2" }] }),
        fixture({ id: "b", expect: [{ gist: "3" }] }),
        fixture({ id: "c", expect: [{ gist: "4" }] }),
      ],
      generate,
    });
    const s = summarize(run);
    expect(s.facts).toBe(4);
    expect(s.factsFiled).toBe(3);
    expect(s.topicCount).toBe(2);
    expect(s.topicsPerFact).toBe(0.5);
    expect(s.topicsPerFiledFact).toBeCloseTo(2 / 3, 10);
    expect(s.factsPerTopic).toBe(2);
  });

  it("reports no ratio rather than a zero when there is nothing to divide by", async () => {
    const { generate } = scripted(['{"kind":"none"}']);
    const s = summarize(await runTopicReuse({ corpus: [fixture({ id: "a" })], generate }));
    expect(s.topicsPerFact).toBeNull();
    expect(s.factsPerTopic).toBeNull();
  });

  it("splits every count by language", async () => {
    const { generate } = scripted([
      '{"kind":"new","name":"Робота"}',
      '{"kind":"existing","topicId":"t01"}',
      '{"kind":"new","name":"Budget"}',
    ]);
    const run = await runTopicReuse({
      corpus: [
        fixture({ id: "a", lang: "uk" }),
        fixture({ id: "b", lang: "uk" }),
        fixture({ id: "c", lang: "en" }),
      ],
      generate,
    });
    const s = summarize(run);
    expect(s.byLang.uk).toMatchObject({ turns: 2, mint: 1, reuse: 1 });
    expect(s.byLang.en).toMatchObject({ turns: 1, mint: 1, reuse: 0 });
  });

  it("records the curve after every turn, so a plateau is visible", async () => {
    const { generate } = scripted([
      '{"kind":"new","name":"Work"}',
      '{"kind":"existing","topicId":"t01"}',
      '{"kind":"new","name":"Budget"}',
    ]);
    const run = await runTopicReuse({
      corpus: [fixture({ id: "a" }), fixture({ id: "b" }), fixture({ id: "c" })],
      generate,
    });
    expect(run.curve).toEqual([1, 1, 2]);
  });
});

describe("the real corpus", () => {
  it("runs end to end against a stub, one row per fixture", async () => {
    // Proof the harness executes at full scale without a provider. The stub answers `none`
    // every time, so the topic list stays empty and nothing here is a claim about a model.
    const corpus = loadCorpus();
    expect(corpus).toHaveLength(54);
    const { generate, prompts } = scripted(corpus.map(() => '{"kind":"none"}'));
    const run = await runTopicReuse({ corpus, generate });
    expect(run.rows).toHaveLength(54);
    expect(prompts).toHaveLength(54);
    expect(run.topics).toHaveLength(0);
    const s = summarize(run);
    expect(s.counts.none).toBe(54);
    expect(s.topicsPerFact).toBe(0);
  });

  it("accumulates a topic list from a stub that mints on every turn", async () => {
    // The pessimistic extreme, drawn to prove the accumulation actually accumulates: one new
    // name per turn is the exact failure mode `slot_key` exhibited on live data.
    const corpus = loadCorpus();
    const { generate } = scripted(corpus.map((f) => JSON.stringify({ kind: "new", name: `topic for ${f.id}` })));
    const run = await runTopicReuse({ corpus, generate });
    expect(run.topics).toHaveLength(54);
    expect(run.curve[53]).toBe(54);
    const s = summarize(run);
    expect(s.counts.mint).toBe(54);
    expect(s.topicsPerFact).not.toBeNull();
  });
});
