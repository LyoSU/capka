import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats, projects, users, attachedFolders } from "@/lib/db/schema";
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
import { makeMemoryTools } from "@/lib/memory/tool";
import { readMemoryDocs } from "@/lib/memory/store";
import { resolvePolicies, isUsable } from "@/lib/governance/policy";
import { resolveAgentProfile, capProfile, parseAgentProfile } from "@/lib/agents/profile";
import { getSandboxNetworkDefault, getMaxContextTokens, getOrgAgentProfile, getOrgInstructions, getSetting, setSetting } from "@/lib/settings";
import { getModelCannotReason, getModelContextLength, getModelEfforts } from "@/lib/models/catalog";
import { availableAmounts, clampAmount, parseThinkAmount } from "@/lib/models/thinking";
import { contextBudget } from "@/lib/chat/context/budget";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { publishTaskEvent } from "./events";
import type { TaskPayload } from "./runner";

/**
 * Re-resolve everything needed to run a task from its persisted payload — the
 * "run context builder". `sessionKey` is the project (shared folder) or the chat
 * itself (see workspaceSessionKey). Memory is scoped to the project plus
 * user-global facts. Split out of runner.ts so the turn loop there is control
 * flow, not setup: this composes the model, the tool set (sandbox + MCP + skill +
 * manage + ask + view_file + memory + provider-native), the system prompt, the
 * context-window budget inputs, and the lazy sandbox session — and returns a
 * ready-to-run bundle plus a `closeMcp` disposer.
 */
export async function prepareRun(userId: string, sessionKey: string, payload: TaskPayload, chatId: string, messageId: string, taskId: string) {
  // A project chat sees its project memory doc + the user-global doc. A
  // standalone chat sees only the user-global doc, so projects don't leak.
  const [{ model, provider, modelId, modelInput, apiStyle, isShared, configId }, project, memoryDocs, user, chat, orgProfile, orgInstructions] = await Promise.all([
    resolveUserModelInfo(userId, payload.requestModel),
    payload.projectId
      ? db.select().from(projects).where(and(eq(projects.id, payload.projectId), eq(projects.userId, userId), projectNotDeleted)).limit(1).then((r) => r[0])
      : Promise.resolve(undefined),
    readMemoryDocs(userId, payload.projectId ?? null),
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
  const sandbox = caps.sandbox ? await loadSandboxTools(sessionKey, userId, ensureSession, networkMode) : empty;
  const mcp = caps.connectors
    ? await loadMcpTools({
        userId,
        projectId: payload.projectId ?? null,
        sessionKey,
        ensureSession,
        isServerAllowed: (name) => isUsable(policy.effect("connector", name)),
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
      ? (await listAvailableSkills(userId, payload.projectId ?? null)).filter((s) => isUsable(policy.effect("skill", s.name)))
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
      ...(caps.memory ? makeMemoryTools({ userId, projectId: payload.projectId ?? null }) : {}),
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

    const prompt = buildSystemPrompt({
      project,
      // Passed unconditionally; the profile decides whether the blocks are rendered.
      // The read itself rode the opening parallel wave (one indexed select) — gating
      // it there would have cost a serial round-trip on every turn to save nothing.
      memoryDocs,
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

    return { model, provider, modelId, modelInput, isShared, configId, tools, viewFileBridge, closeMcp: closeAll, prompt, contextLength, adminCap, toolSearch, profile, thinkAmount, modelEfforts, modelCannotReason };
  } catch (e) {
    await closeAll();
    throw e;
  }
}
