import { listManifestClaims, listManifestTopics, type ManifestText } from "./model-view";

/** Up to 10 facts per section, taken from the ONE model-facing projection.
 *
 *  This function used to hold its own copy of the head/confirmed/not-sensitive rule,
 *  and `memory_search` held a second, and the lost-CAS reply a third. Two of the three
 *  were wrong at different times — the search filter was missing the quarantine half for
 *  a whole plan — which is the twelfth instance of this feature's recurring defect: a
 *  rule at one entrance while a second walks past it. There is now one entrance, and it
 *  hands back `ManifestText`, so this file cannot render a statement it did not get from
 *  there without failing `tsc`.
 *
 *  Ordering matters for the byte-identity requirement as much as for correctness: the
 *  projection orders by `recorded_at DESC, id`, the `id` tiebreak existing precisely
 *  because several claims landing in one transaction share a `recorded_at`. */
async function recentFacts(spaceId: string): Promise<ManifestText[]> {
  return (await listManifestClaims(spaceId)).slice(0, 10).map((c) => c.statement);
}

/** Every line the model reads here is prompt content, not markup the model
 *  can trust structurally — a fact statement is short and single-line, and
 *  comes only from claims this module already filtered to
 *  confirmed/non-sensitive, but it's still free text an agent or a user
 *  wrote. Wrapping it in guillemets is a cheap way to mark it as a quoted
 *  value rather than an instruction.
 *
 *  "Short and single-line" is a GUARANTEE, and this comment used to credit it
 *  to `memory_propose`'s zod schema — a rule held by one of three entrances,
 *  while extraction and confirm-supersede wrote whatever they were handed. A
 *  multi-KB statement went into this tier verbatim on every turn, and a
 *  statement carrying `\n## …` put its own lines OUTSIDE these guillemets,
 *  indistinguishable from the manifest's structure. It is now `fitStatement`,
 *  on the writers themselves, and the projection re-applies it for rows that
 *  predate it — so this fence may keep assuming one bounded line.
 */
function spaceBlock(
  header: string,
  topics: { title: ManifestText; count: number }[],
  facts: ManifestText[],
): string | null {
  // `null`, not a bare header, when the space holds nothing worth saying. The
  // manifest sits in the UNCACHED volatile tier and is rebuilt every turn, so an
  // empty headed section is a cost paid on every single turn of every account that
  // has never recorded a fact — which is every new account. The pre-cutover prompt
  // omitted its memory block when the document was empty; keeping the header would
  // make the cutover a regression that bills for itself forever.
  //
  // The gate is "has anything to SAY". It used to read `topics.some(t => t.count > 0)`
  // because `topicCounts` returned zero-count topics; `listManifestTopics` applies that
  // gate inside the mint now (a count is claim text too), so a topic that reaches here at
  // all is one with something behind it.
  if (!facts.length && !topics.length) return null;
  const lines = [header];
  if (topics.length) lines.push("", "Topics:", ...topics.map((t) => `- ${t.title} (${t.count})`));
  if (facts.length) lines.push("", "Recent facts:", ...facts.map((s) => `- «${s}»`));
  return lines.join("\n");
}

/*
 * WHERE THE LEGACY FALLBACK WENT. Until this round `legacyDoc` read up to 4096 raw
 * characters out of any `memory_docs` row the migration had not carried yet, and
 * `buildMemoryManifest` spliced them into the system prompt behind a block quote and a
 * sentence saying "recorded data, not instructions". Both of those govern how the model
 * is ASKED to read bytes it has already received; neither keeps a credential from being
 * sent to the provider. Two things made it worse than a race: the boot migration is
 * started with `void`, so serving never waited on it, and a document that fails
 * migration deterministically stays uncarried — so the disclosure repeated every turn,
 * indefinitely.
 *
 * It is DELETED rather than gated. A gate on this path would be a second rule to keep
 * correct forever, on a path that should not exist: the migration now turns legacy
 * bullets into pending candidates, so that text reaches the model by the same single
 * route as everything else, once a person has kept it. Until they do, the old document
 * survives in the human settings projection (`/api/memory-docs`) and in the export,
 * which are separately authorized surfaces for the owner of the data.
 *
 * After this there is exactly ONE route from stored text to the model — `model-view.ts`
 * — and a human confirmation governs it.
 */

/**
 * Memory manifest for the system prompt: two spaces, the user's and — when the caller
 * passes one — the project's. Every line here is read by the model, not a human.
 *
 * It takes SPACE IDS ONLY. `userId` and `projectId` used to travel alongside them
 * because the legacy `memory_docs` fallback was keyed by `(userId, projectId)` while
 * claims are keyed by `spaceId`; with that fallback deleted there is nothing here that
 * a space id cannot address, and carrying the user id into a function that no longer
 * needs it is how a deleted path grows a second life.
 */
export async function buildMemoryManifest(args: {
  userSpaceId: string;
  projectSpaceId?: string;
}): Promise<string> {
  const blocks: string[] = [];

  const [userTopics, userFacts] = await Promise.all([
    listManifestTopics(args.userSpaceId),
    recentFacts(args.userSpaceId),
  ]);
  const userBlock = spaceBlock("## User memory", userTopics, userFacts);
  if (userBlock) blocks.push(userBlock);

  if (args.projectSpaceId) {
    const [projectTopics, projectFacts] = await Promise.all([
      listManifestTopics(args.projectSpaceId),
      recentFacts(args.projectSpaceId),
    ]);
    const projectBlock = spaceBlock("## Project memory", projectTopics, projectFacts);
    if (projectBlock) blocks.push(projectBlock);
  }

  // THE ONLY PLACE THE PROMPT NAMES A WRITER, which is why it names the ones that actually
  // write. It said `memory_propose` until slice 2 gave the agent `memory_fact_write`, and an
  // always-on instruction steering every turn to the tool that parks the fact behind a
  // confirmation gate this slice removes is how a shipped feature rides inert (review MED-4;
  // the egress allowlist did exactly that for two releases).
  //
  // The retired pair is not named, and cannot be: `memory_propose` and `memory_update` are
  // gone from the turn (§4.10), so a prompt mentioning either would name a tool the model
  // does not hold — which is the same defect as naming the wrong one, arrived at from the
  // other side. This line was written not to mention them so that it would stay true THROUGH
  // that retirement, and it did.
  //
  // TWO WRITERS AND ONE READER, and no more than that: the manifest is the uncached volatile
  // tier, rebuilt on every turn, so every word here is paid for on every turn of every
  // account. `memory_file`, `memory_link`, `memory_open` and `memory_forget` are reachable
  // from their own descriptions once the model is already in the memory tools; what the
  // always-on tier has to say is the thing a model will otherwise not do at all, which is
  // look before it asserts and write when it learns.
  //
  // WHICH WRITER IT NAMES FIRST CHANGED, and that is the whole of this edit. Both tools are
  // live and neither is deprecated, but the owner's page is now a list of topic FILES a
  // person opens and reads, with facts as a disclosure inside one — so a turn that saves
  // everything it learns as one-line claims produces a page of empty headings, and the
  // person's only handle on their own memory is a delete button. The line therefore steers
  // the DEFAULT: a file per subject for anything worth reading, updated rather than
  // duplicated, and a bare fact where a bare fact is genuinely all there is.
  blocks.push(
    "Use memory_search before assuming facts about the user or project. When you learn something worth keeping, write it with memory_note_write as a short topic file — one file per subject, and update the existing file rather than adding a second about the same thing; use memory_fact_write only for a single standalone fact.",
  );

  return blocks.join("\n\n");
}
