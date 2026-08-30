# Extraction eval

`extract.ts` mines every finished turn for facts worth remembering. Nothing
measured how well it does that: a pending queue simply grew, and a prompt edit
could only ever be described as a *change*, never as an improvement or a
regression. This directory is the missing scale.

## What it measures, and against what

`corpus.jsonl` is a labelled set of conversation turns. Each line is one turn
plus what a careful person would want remembered from it — and, just as
important, what they would want left alone.

Two rules shape the file, and both are load-bearing:

**The specimen is in its own language; the labels are in the repo's.** The
`user` and `assistant` fields hold real Ukrainian, English, and code-switched
text, because language handling is a large part of what is being measured and a
translated corpus would measure a translation. Every field around them — `gist`,
`why`, `forbid` — is English, so the file reads to anyone reviewing it and the
repo's language convention holds everywhere it can. This is the same standing
exception `extract.ts` carries for its Ukrainian few-shot example, for the same
reason: removing the Cyrillic would remove the thing under test.

**The harness runs the SHIPPED prompt.** It imports `EXTRACT_INSTRUCTION` and
the parsing from `extract.ts` rather than restating them. A harness that copies
the prompt measures the copy, and goes on passing after the real one drifts.

## Why the labels are not exact strings

The model paraphrases, and it is *supposed* to — the instruction asks it to
reuse the user's wording where that works, which means the output is not
predictable character by character. Asserting on exact statements would fail on
correct extractions and would have to be re-tuned for every model.

So a label states the **gist** in English, and matching an extracted statement
to a gist is done by a judge model. That keeps the metric language-neutral and
model-neutral: nothing here holds a word list, a stemmer, or a per-language
rule, and adding Portuguese needs new corpus lines and no new code.

Structural claims — `scope`, `sensitive` — are asserted directly once an item is
matched, because those are enumerated values and need no judgement.

## The one lexical check, and why it is not a hardcode

A fixture that plants a credential names it in `plantedSecret`. The harness then
requires that any extracted item containing that exact string carries
`sensitive: true`. The string is a parameter of the fixture that planted it, not
an entry in a global list of things that look like secrets — so it stays true
for a secret in any language, of any shape, that no list would have anticipated.

## The judge needs its own control

A judge model that answered "matched" to everything would report a perfect score
and be worthless, and nothing about a good-looking number would reveal it. So
the harness feeds the judge, alongside the real run, a deliberately correct set
and a deliberately wrong one whose answers are already known. If the judge does
not separate those two, the run reports **no score at all** rather than a
flattering one — a control whose reading cannot change is decoration.
