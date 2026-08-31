import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats, messages, projects, users, attachedFolders } from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { providerNativeTools } from "@/lib/providers";
import { modelTakesImages, supportsImageToolResults } from "@/lib/providers/registry";
import { loadSandboxTools } from "@/lib/sandbox/tools";
import { createSession } from "@/lib/sandbox/client";
import { makeViewFileTool } from "@/lib/sandbox/view-file";
import { loadMcpTools } from "@/lib/mcp/load";
import { planToolSearch } from "@/lib/mcp/tool-search";
import { listAvailableSkills } from "@/lib/skills/service";
import { makeSkillTool } from "@/lib/skills/tool";
import { makeManageTool } from "@/lib/manage/tool";
import { hostFolderEnabled, sessionMounts } from "@/lib/manage/controls/folders";
import { makeAskTool } from "@/lib/ask/tool";
import { askAnswerSchema, askFormSchema } from "@/lib/ask/types";
import { makeVaultMemoryTools } from "@/lib/vault/tools";
import { makeVaultBudget } from "@/lib/vault/budget";
import { makeHandleMap } from "@/lib/vault/handles";
import { buildMemoryManifest } from "@/lib/vault/manifest";
import { getOrCreateSpace } from "@/lib/vault/spaces";
import { makeTurnTaint } from "./turn-taint";
import { resolvePolicies, isOffered } from "@/lib/governance/policy";
import { resolveAgentProfile, capProfile, parseAgentProfile } from "@/lib/agents/profile";
import { getSandboxNetworkDefault, getMaxContextTokens, getOrgAgentProfile, getOrgInstructions, getSetting, setSetting } from "@/lib/settings";
import { getModelCannotReason, getModelContextLength, getModelEfforts } from "@/lib/models/catalog";
import { availableAmounts, clampAmount, parseThinkAmount } from "@/lib/models/thinking";
import { contextBudget } from "@/lib/chat/context/budget";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { publishTaskEvent } from "./events";
import type { TaskPayload } from "./runner";

/**
 * The user's own words inside an answered `ask`, and nothing else.
 *
 * An approval/`ask` continuation carries `uiMessages: []` — the user's answer rides
 * `resumeMessages` and is not a chat message at all — so `userTurnText` read "" and a
 * fact the user stated while approving ("yes, and remember we pay in EUR") landed
 * `derived`. This is the fold the F7 trigger comment asked for: ONE more source for the
 * ONE value, here, rather than a second consumer deriving its own.
 *
 * Only free-text fields count, and that exclusion is the whole security content of this
 * function. The FORM is model-authored: a `choice` field's option labels are the model's
 * own text, so counting a selected option as the user's words would let a model put the
 * fact it wants remembered into an option, have the person click it, and activate it on
 * their authority. `submit` only — a skip states nothing.
 *
 * Manage approvals contribute nothing: `ApprovalDecision.reason` is typed but no caller
 * supplies it. A caller that starts to must fold it in HERE, beside this.
 */
export function userWordsFromAnswer(metadata: unknown): string {
  const parts = (metadata as { parts?: unknown[] } | null)?.parts;
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const part of parts) {
    const answer = (part as { answer?: { form?: unknown; value?: unknown } })?.answer;
    const form = askFormSchema.safeParse(answer?.form);
    const value = askAnswerSchema.safeParse(answer?.value);
    if (!form.success || !value.success || value.data.action !== "submit") continue;
    for (const field of form.data.fields) {
      if (field.kind !== "text" && field.kind !== "number") continue;
      const v = value.data.values[field.id];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out.join("\n");
}

/**
 * Everything the SUSPENDED half of a turn left on its own row, in ONE read.
 *
 * Both values belong to the same message and are needed at the same moment, so they
 * ride one select rather than two: the user's words inside an answered `ask`, and
 * whether that half had already read untrusted content. The second is what makes the
 * taint survive the split — an approval/`ask` continuation is a SECOND task, none of
 * the construction sites re-runs for a rehydrated input, and a taint recomputed from
 * this task alone would read clean while half 1's retrieved text sits verbatim in the
 * context half 2 is reading. See `makeTurnTaint`, and `foldTurnHalves` for the
 * precedent this follows.
 *
 * Exported so the seed has a reader a test can drive: prepareRun's resume arm is
 * nothing but a call to this, and "the column is right and nobody reads it" is the
 * failure an assertion on the column alone cannot see.
 */
export async function readResumeRow(resumeMessageId: string | null): Promise<{ answeredAsk: string; untrustedIngressSeeded: boolean }> {
  if (!resumeMessageId) return { answeredAsk: "", untrustedIngressSeeded: false };
  const [row] = await db
    .select({ metadata: messages.metadata, untrustedIngress: messages.untrustedIngress })
    .from(messages)
    .where(eq(messages.id, resumeMessageId))
    .limit(1);
  return { answeredAsk: userWordsFromAnswer(row?.metadata), untrustedIngressSeeded: row?.untrustedIngress === true };
}

/**
 * Re-resolve everything needed to run a task from its persisted payload — the
 * "run context builder". `sessionKey` is the project (shared folder) or the chat
 * itself (see workspaceSessionKey). Memory is scoped to two vault spaces: the
 * user's, plus the project's when the chat is in one. Split out of runner.ts so the turn loop there is control
 * flow, not setup: this composes the model, the tool set (sandbox + MCP + skill +
 * manage + ask + view_file + memory + provider-native), the system prompt, the
 * context-window budget inputs, and the lazy sandbox session — and returns a
 * ready-to-run bundle plus a `closeMcp` disposer.
 */
export async function prepareRun(userId: string, sessionKey: string, payload: TaskPayload, chatId: string, messageId: string, taskId: string) {
  // Memory is NOT resolved here. It needs the project row (for the space's owner)
  // and the capability profile (which decides whether to touch memory at all), and
  // a space is a WRITE — a `getOrCreateSpace` riding this wave would create one for
  // a project that turns out to be deleted. It happens below, once both are known.
  const [{ model, provider, modelId, modelInput, apiStyle, isShared, configId }, project, user, chat, orgProfile, orgInstructions] = await Promise.all([
    resolveUserModelInfo(userId, payload.requestModel),
    payload.projectId
      ? db.select().from(projects).where(and(eq(projects.id, payload.projectId), eq(projects.userId, userId), projectNotDeleted)).limit(1).then((r) => r[0])
      : Promise.resolve(undefined),
    db.select({ name: users.name, timezone: users.timezone, locale: users.locale, role: users.role, agentProfile: users.agentProfile })
      .from(users).where(eq(users.id, userId)).limit(1).then((r) => r[0]),
    db.select({ createdAt: chats.createdAt, thinkAmount: chats.thinkAmount }).from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0]),
    getOrgAgentProfile(),
    getOrgInstructions(),
  ]);

  // The task was enqueued for a project that has since been deleted (a worker retry
  // of an old task, or a delete that raced the enqueue). Running now would apply the
  // gone project's egress and point at its wiped workspace — fail calmly instead.
  if (payload.projectId && !project) {
    throw new Error("This project was deleted, so this chat can no longer run here. Start a new chat to continue.");
  }

  // What this project lets its agent be, clamped by the org ceiling AND by the
  // user's own choices (today: whether they want memory at all). Each capability
  // group below gates BOTH its tools (here) and its prompt block (in
  // buildSystemPrompt) — see agents/profile.ts for why those two must move
  // together. A chat with no project resolves to the assistant default and is then
  // clamped just the same, so an org ceiling reaches project-less chats too.
  //
  // Three layers, folded by a commutative minimum: whoever says "no" wins, and no
  // layer can hand back what another took away.
  const profile = resolveAgentProfile(
    project?.agentProfile,
    capProfile(parseAgentProfile(user?.agentProfile), orgProfile),
  );
  const caps = profile.capabilities;

  // The vault spaces this turn can see. Resolved HERE and not in the opening wave
  // for two reasons that both matter: `getOrCreateSpace` WRITES, so it must not run
  // for a project the check above just rejected, and the project space's owner is
  // `projects.userId` — the project's real owner, never the caller, since
  // `purgeUserSpaces` keys on exactly that column and a collaborator's id there
  // would outlive the owner's deletion.
  //
  // Gated on `caps.memory`: with memory off there is nothing to read and no reason
  // to create a row. The old code read the doc unconditionally because a read is
  // free; a space is not.
  const userSpaceId = caps.memory ? await getOrCreateSpace({ type: "user", refId: userId }) : undefined;
  const projectSpaceId =
    caps.memory && project
      ? await getOrCreateSpace({ type: "project", refId: project.id, ownerUserId: project.userId })
      : undefined;

  // The text of the turn's last user message, which is what `memory_propose` checks
  // a proposed fact against before it can activate without the user's confirmation.
  // An empty string is a fail-safe, not an error: provenance then reads `derived`
  // and the fact waits for confirmation instead of going in on the model's word.
  //
  // Computed ONCE, here, and handed to every consumer on the bundle — the memory
  // tools and the runner's post-turn extraction both. The runner used to re-derive
  // it from `modelMessages`, which is not the transcript: it carries the runner's
  // OWN synthetic `role:"user"` messages (the effect-ledger recovery note), so on
  // any continued turn the security predicate was verifying facts against a list of
  // tool names and clamped tool arguments. `payload.uiMessages` is the only source
  // that holds what a person actually typed.
  //
  // KNOWN AND NOW CLOSED (Fable audit F7). An approval/`ask` continuation arrives with
  // `uiMessages: []` — the user's ANSWER rides `resumeMessages` and is not a chat message
  // at all — so this read "" on that half of the turn and a fact the user stated while
  // approving was `derived`: pending, and invisible until a review queue existed. The
  // answer is durable on the message row, so it is folded in HERE, as one more source for
  // this SINGLE value. Anything else that ever makes the answer part of the transcript
  // folds in here too; a second consumer with its own derivation is precisely what F1 was.
  const { answeredAsk, untrustedIngressSeeded } = await readResumeRow(payload.resumeMessageId ?? null);

  // NO TAINT MARK HERE, and the absence is the decision rather than an omission: this is
  // the `user_authored` half. What a person typed — and what they typed inside an answered
  // `ask`, which `userWordsFromAnswer` already narrows to free-text fields — is the one
  // ingress the turn taint is measured AGAINST. Marking it would make every turn untrusted
  // and the distinction empty.
  const userTurnText =
    (() => {
      const uiMessages = payload.uiMessages ?? [];
      for (let i = uiMessages.length - 1; i >= 0; i--) {
        const m = uiMessages[i];
        if (m?.role !== "user") continue;
        if (typeof m.content === "string") return m.content;
        const parts: unknown[] = Array.isArray(m.parts) ? m.parts : [];
        return parts
          .filter((p): p is { type: string; text: string } =>
            typeof (p as { text?: unknown })?.text === "string" && (p as { type?: unknown })?.type === "text")
          .map((p) => p.text)
          .join("\n");
      }
      return "";
    })() || answeredAsk;

  // THE TURN'S THREE PER-TURN OBJECTS, constructed once, here, because the tool factory
  // below is called exactly once per turn and all three have exactly its lifetime: the
  // handle map is the only address space the model is shown, the budget is what the vault
  // may spend of this turn's context, and the taint is whether the turn has read anything
  // it did not author. A second instance of any of them would give one turn two answers to
  // one question — two `m1`s, two ceilings, half a turn's marks.
  //
  // They are built HERE rather than inside the factory so the runner can hold the taint
  // too: the assembled-row fold and the provider-result site are outside the vault
  // entirely. The handle map and the budget do not need to escape.
  //
  // The taint is SEEDED, not recreated: an approval/`ask` continuation is a second task
  // writing the same message row, and `readResumeRow` above already carries that row's
  // stored mark. Handles and budget are deliberately NOT seeded — a fresh task gets a
  // fresh address space and a fresh allowance (§4.1).
  const handles = makeHandleMap();
  const budget = makeVaultBudget();
  const taint = makeTurnTaint({ messageId, seeded: untrustedIngressSeeded });

  // Sandbox tools (execute_bash, read_file, …) + MCP connector tools (sub-project
  // B, namespaced mcp__<server>__<tool>) + the skill tool. Each piece has a stable
  // definition across runs, and the merge order is deterministic, so the
  // position-0 tools prefix stays cache-stable turn-to-turn.
  // Governance: an admin `deny` removes a skill/connector from the agent entirely.
  const policy = await resolvePolicies(userId, payload.projectId ?? null);
  // Egress: a project may force "bridge"; otherwise fall back to the org default.
  // The controller still gates bridge on SANDBOX_ALLOW_NETWORK.
  const networkMode = project?.sandboxNetwork === "bridge" ? "bridge" : await getSandboxNetworkDefault();
  // Folders attached to this session. HOST folders (admin-confirmed server dirs)
  // become bind-mounts the controller mounts at /folders/<name>. PC folders aren't
  // mounts — the browser bridge syncs them into /workspace/<name>. Both are listed
  // in the prompt so the model knows where they are (esp. that files it puts under
  // a PC folder's /workspace/<name> flow back to the user's computer) — which is
  // why a sandbox-less project skips the lookup outright: without the file tools
  // that read them, listing mounts would only describe places it can't reach.
  const [folderRows, hostEnabled] = caps.sandbox
    ? await Promise.all([
        db.select().from(attachedFolders).where(eq(attachedFolders.sessionKey, sessionKey)),
        hostFolderEnabled(),
      ])
    : [[] as (typeof attachedFolders.$inferSelect)[], false];
  // Host folders are only real when the admin gate is on — otherwise don't tell
  // the model /folders/<name> exists (it won't be mounted; see ensureSession).
  const hostFolders = hostEnabled ? folderRows.filter((f) => f.kind === "host") : [];
  const pcFolders = folderRows.filter((f) => f.kind === "pc");
  // Lazy, shared sandbox session: created (with the resolved networkMode) on the
  // FIRST consumer that actually needs the container — a sandbox tool call, a
  // stdio MCP connector, or an invoked skill. Memoized so all three share one
  // container and the networkMode is set exactly once. A chat that triggers none
  // of these never spins a sandbox.
  let sessionEnsured: Promise<unknown> | null = null;
  const ensureSession = () => {
    // Memoize the success; on failure clear it so a later consumer can retry
    // (a transient controller blip shouldn't poison the whole turn's sandbox).
    if (!sessionEnsured) {
      // Building the container takes 10-20s and it happens INSIDE whatever asked
      // for it — usually the turn's first sandbox tool call, where the timeline
      // already says "Running a command" and then sits there. Announce the phase
      // so that pause has a name, and retract it on settle (success or failure)
      // so the label can never outlive the work. Fire-and-forget in both
      // directions: a realtime hiccup must not delay or fail the container.
      const phase = (p: "sandbox" | null) =>
        void publishTaskEvent(userId, {
          type: "task:notice", taskId, chatId, messageId, notice: { kind: "phase", phase: p },
        }).catch(() => {});
      phase("sandbox");
      // Resolve mounts FRESH at create time (not a prepareRun snapshot): a folder
      // attached mid-turn via `manage` recreates the container with the new mount,
      // and a stale [] here would make the controller see drift and tear it back
      // down. sessionMounts is gated on host_folder_access, so a disabled gate
      // un-mounts on the next (re)create.
      sessionEnsured = sessionMounts(sessionKey)
        .then((mounts) => createSession(sessionKey, userId, networkMode, mounts))
        .then((session) => {
          phase(null);
          return session;
        })
        .catch((e) => {
          phase(null);
          sessionEnsured = null;
          throw e;
        });
    }
    return sessionEnsured;
  };
  // A group that's off is never LOADED, not merely filtered out afterwards: that's
  // what makes a tool-less project genuinely cheap — no container is ever created
  // (nothing reaches `ensureSession`) and no stdio connector child process spawns.
  const empty = { tools: {}, close: async () => {} };
  // Dropping the memo is the whole recovery when a sandbox dies mid-turn: the
  // controller has already forgotten the session, so the next consumer that calls
  // `ensureSession` builds a fresh container against the same (bind-mounted, and
  // therefore surviving) workspace instead of retrying against a dead handle.
  const sandbox = caps.sandbox
    ? await loadSandboxTools(sessionKey, userId, ensureSession, networkMode, () => { sessionEnsured = null; })
    : empty;
  // The turn's citation counter: search-shaped connector results number their
  // records through it, so `[N]` stays unique across every search call of the
  // run. A continuation reusing the same message seeds it past the first
  // half's numbers (see runner.ts) — that's why the counter rides the bundle.
  const sourceCounter = { next: 1 };
  const mcp = caps.connectors
    ? await loadMcpTools({
        userId,
        projectId: payload.projectId ?? null,
        sessionKey,
        ensureSession,
        isServerAllowed: (name) => isOffered(policy.effect("connector", name)),
        // An "ask" connector's every call suspends for the user's approval
        // (SDK needsApproval → the awaiting_approval card on web/Telegram).
        serverNeedsApproval: (name) => policy.effect("connector", name) === "ask",
        sourceCounter,
        // Lets a connector elicit input from the user mid-tool-call (block-and-poll).
        elicitContext: { userId, chatId, messageId, origin: payload.origin },
      })
    : empty;
  // The sandbox + MCP clients are now LIVE (stdio MCP servers may hold child
  // processes). Define their disposer immediately so any throw in the rest of
  // prepareRun — listAvailableSkills, buildSystemPrompt, getModelContextLength —
  // closes them instead of leaking them: the caller only learns of `closeAll`
  // from a successful return, so it can't clean up after a mid-function throw.
  const closeAll = async () => { await Promise.allSettled([sandbox.close(), mcp.close()]); };
  try {
    const availableSkills = caps.skills
      ? (await listAvailableSkills(userId, payload.projectId ?? null)).filter((s) => isOffered(policy.effect("skill", s.name)))
      : [];
    // `view_file` (render a workspace file to image so the model can SEE it) is
    // offered only to a model that takes images at all. HOW the image reaches the
    // model splits by transport: capable adapters carry it in the tool result
    // (emitImageToolResult); chat-completions transports can't, so the runner
    // bridges it as a following user message (viewFileBridge → prepareStep).
    // Stricter than a user attachment's gate: view_file images have no soft-retry,
    // so an over-claimed capability would fail the turn (see modelTakesImages).
    const visionOk = modelTakesImages(provider, modelInput);
    const emitImageToolResult = supportsImageToolResults(provider, apiStyle);
    const viewFileBridge = visionOk && !emitImageToolResult;
    const tools = {
      ...sandbox.tools,
      ...(caps.sandbox && visionOk ? makeViewFileTool({ sessionKey, userId, ensureSession, emitImageToolResult }) : {}),
      ...mcp.tools,
      // Skills without the sandbox still deliver their instructions: `ensureSession`
      // is documented as optional precisely for that body-only path, so withholding
      // it keeps a skill useful without spinning a container to materialize files
      // the model would then have no tools to read.
      ...(caps.skills
        ? {
            skill: makeSkillTool({
              userId,
              sessionKey,
              projectId: payload.projectId ?? null,
              ensureSession: caps.sandbox ? ensureSession : undefined,
              // Governance reaches the tool itself, not just the prompt list: a
              // "deny" skill is refused even if the model calls it by name, and an
              // "ask" skill suspends for the user's approval before loading.
              effectFor: (name) => policy.effect("skill", name),
            }),
          }
        : {}),
      // Conversational control plane: lets the user manage their own preferences,
      // and admins manage platform-wide config, all in chat. Role is fixed here
      // from the session identity (not the model's arguments), and risky org-wide
      // changes are STAGED — applied only by the user's own click (web/Telegram),
      // never by the model, so this tool can't self-confirm a change.
      //
      // `ask` (NO execute: when the model calls it the AI SDK tool-loop stops, which
      // the runner turns into a durable "awaiting_answer" suspend resolved by the
      // user's reply) rides the same group — both are the agent coordinating with
      // the human, and without either the model just asks in prose.
      ...(caps.manage
        ? {
            ...makeManageTool({
              userId,
              isAdmin: user?.role === "admin",
              projectId: payload.projectId ?? null,
              sessionKey,
              locale: user?.locale ?? payload.origin?.locale ?? undefined,
              // A created automation inherits the model this turn runs on (the chat's ref).
              model: payload.requestModel ?? null,
            }),
            ...makeAskTool(),
          }
        : {}),
      // EXACTLY ONCE per turn, and that is load-bearing: the factory keeps this
      // turn's lost-CAS claim ids in its closure, so a second call would give the
      // turn a second empty set and a repeated conflict would never be recorded.
      // `projectOwnerUserId` is mandatory whenever there is a project — the factory
      // throws without it rather than filing the fact in the wrong space.
      ...(caps.memory
        ? await makeVaultMemoryTools({
            userId,
            projectId: project?.id ?? null,
            projectOwnerUserId: project?.userId,
            messageId,
            taskId,
            userTurnText,
            handles,
            budget,
            taint,
          })
        : {}),
      // Provider-executed tools (e.g. Gemini's Google Search grounding); empty for
      // providers without any. Grouped with connectors — from the model's side both
      // are "reach outside Capka for data".
      ...(caps.connectors ? providerNativeTools(provider) : {}),
    };

    // Workspace snapshot — read straight off disk via the controller's file API
    // (HMAC-token, no live container). This keeps the sandbox lazy: a chat that
    // never runs code stays container-free, yet the model still sees existing files.
    let workspaceSnapshot: string | undefined;
    if (caps.sandbox) {
      try {
        const { listFiles } = await import("@/lib/sandbox/client");
        // depth 3 mirrors the old `find -maxdepth 3` snapshot, but off disk (no container).
        const { entries } = await listFiles(sessionKey, ".", userId, 3);
        if (entries?.length) {
          workspaceSnapshot = entries
            .slice(0, 50)
            .map((e) => (e.isDirectory ? `${e.path}/` : e.path))
            .join("\n");
        }
      } catch { /* no workspace yet */ }
    }

    // One-time first-run concierge: on the admin's very first chat turn after
    // setup, arm a prompt nudge to welcome them and offer to configure optional
    // things via `manage`. The flag (set at setup completion) is consumed here so
    // it fires exactly once. The getSetting only runs on a chat's first turn by an
    // admin, so it costs nothing on the steady-state path. Skipped without the
    // `manage` group — the nudge's entire content is an offer to use that tool, and
    // consuming the one-shot flag there would burn it on a chat that can't act.
    let concierge = false;
    if (caps.manage && user?.role === "admin" && (payload.uiMessages?.length ?? 0) <= 1) {
      if ((await getSetting("concierge_pending")) === userId) {
        concierge = true;
        await setSetting("concierge_pending", ""); // consume — never nudge twice
      }
    }

    // Context-window budget inputs: the model's real window (catalog) and any
    // admin cap (which only ever tightens it). Fetched up front — the effective
    // window drives both the deferral decision below and the NEXT-turn compaction
    // check (which reuses contextLength/adminCap after the turn).
    const [contextLength, adminCap, modelEfforts, modelCannotReason] = await Promise.all([
      getModelContextLength(modelId),
      getMaxContextTokens(),
      // The `reasoning_effort` enum this model has taught us, so the very first
      // request of this turn already carries a value it accepts.
      getModelEfforts(modelId),
      // Whether it told us it accepts no reasoning knobs at all — so a model that
      // cannot reason stops paying a rejected request and a stream restart every
      // turn. Rides this wave rather than costing a serial round-trip.
      getModelCannotReason(modelId),
    ]);
    const effectiveLimit = contextBudget({ usedTokens: 0, modelContextLength: contextLength, adminCap: adminCap || null }).effectiveLimit;
    // Progressive tool disclosure: when the connector tools would tax the window,
    // hide them behind `find_tool` + a compact system-prompt index instead of
    // serializing every schema every turn (provider-agnostic; see tool-search.ts).
    // Inert (all tools active, empty index) below the threshold.
    const toolSearch = planToolSearch({ tools, effectiveLimit });
    if (toolSearch.defer) Object.assign(tools, toolSearch.extraTools);

    // Topics and the facts the person has confirmed — assembled and fenced by the
    // vault. Skipped entirely when memory is off (no space was resolved to build it
    // from). Nothing unconfirmed reaches this string: the legacy free-text fallback
    // that used to ride along here is deleted, and one projection decides the rest.
    const memoryManifest = userSpaceId ? await buildMemoryManifest({ userSpaceId, projectSpaceId }) : "";

    const prompt = buildSystemPrompt({
      project,
      memoryManifest,
      skills: availableSkills.map((s) => ({ name: s.name, description: s.description, body: s.body })),
      workspaceSnapshot,
      user: user ? { name: user.name, timezone: user.timezone } : null,
      attachedFolders: hostFolders.map((f) => ({ name: f.name, readOnly: f.readOnly })),
      syncedFolders: pcFolders.map((f) => ({ name: f.name })),
      conversationStartedAt: chat?.createdAt ?? null,
      locale: user?.locale ?? payload.origin?.locale ?? null,
      concierge,
      connectorIndex: toolSearch.indexText,
      networkMode,
      profile,
      orgInstructions,
    });

    // Thinking depth is the CHAT's setting, read here rather than carried on the
    // payload: a queued turn must reflect the depth the chat has now, and two
    // devices editing the same chat can't drift.
    const thinkAmount = clampAmount(
      parseThinkAmount(chat?.thinkAmount),
      availableAmounts(provider, modelEfforts),
    );

    // `userSpaceId`/`projectSpaceId` ride the bundle so the post-turn extraction in
    // the runner writes into the same spaces this prompt was built from, without
    // resolving them a second time. `userTurnText` rides it for the stronger version
    // of the same reason: it is the anchor `verifyDirectProvenance` checks a fact
    // against, so a second derivation of it downstream is not a duplicate value but a
    // second definition of who "the user" is — and the runner's own `modelMessages`
    // has synthetic `role:"user"` entries in it that this text must never be.
    // `taint` rides it — the OBJECT, not the seed it was built from — because the turn
    // taint is per-MESSAGE and this task may be the SECOND half writing that message (see
    // readResumeRow), while the runner holds two of its mark sites: the assembled-row fold
    // and the provider-executed tool result. One object, marked from both sides.
    return { model, provider, modelId, modelInput, isShared, configId, tools, viewFileBridge, closeMcp: closeAll, prompt, contextLength, adminCap, toolSearch, profile, thinkAmount, modelEfforts, modelCannotReason, sourceCounter, userSpaceId, projectSpaceId, userTurnText, taint };
  } catch (e) {
    await closeAll();
    throw e;
  }
}
