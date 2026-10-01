import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireActive, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { projectNotDeleted } from "@/lib/projects/live";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { reserveBudget, releaseHold } from "@/lib/billing/limits";
import { BudgetExceededError, isAppError } from "@/lib/errors";
import { enqueueTask, settleMovedPast, type QueueTx } from "@/lib/tasks/queue";
import type { TaskPayload } from "@/lib/tasks/runner";
import type { FileRef } from "@/lib/constants";
import { toUIMessages } from "@/lib/chat/presenter";
import { readTurnWrites } from "@/lib/vault/turn-writes";
import { loadActivePath, switchSibling } from "@/lib/chat/tree";
import { chatRequestSchema } from "@/lib/chat/contracts";
import { take } from "@/lib/rate-limit";

export const POST = apiHandler(async (req: Request) => {
  // A pending (awaiting-approval) account must never reach the model — this is the request
  // that spends the shared key. That gate is requireSession's now: it refuses every
  // non-active status, so the check that used to stand here could no longer be reached.
  const { userId, role } = await requireRole("admin", "user");

  // Cheap per-user flood guard (single-instance, in-memory). The client maps the
  // 429 to a friendly, localized message.
  const rl = take(`chat:${userId}`);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many messages — please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const parsed = chatRequestSchema.safeParse(await req.json());
  if (!parsed.success) {
    // The one malformed body a person can produce by typing — coded so the client
    // shows it in the user's language rather than this English line.
    if (parsed.error.issues.some((i) => i.code === "too_big" && i.path[0] === "userMessage")) {
      return Response.json({ error: "This message is too long.", code: "MESSAGE_TOO_LONG" }, { status: 400 });
    }
    throw parsed.error;
  }
  const body = parsed.data;
  const { chatId: requestChatId, model: requestModel, thinkAmount, projectId, userMessage, userMessageId, attachedFiles } = body;
  const chatId = requestChatId || nanoid();

  const [chatRow, project] = await Promise.all([
    requestChatId
      ? db
          .select({
            id: chats.id,
            userId: chats.userId,
            title: chats.title,
            model: chats.model,
            thinkAmount: chats.thinkAmount,
            projectId: chats.projectId,
            projectDeletedAt: projects.deletedAt,
            source: chats.source,
            activeLeafId: chats.activeLeafId,
          })
          .from(chats)
          .leftJoin(projects, eq(chats.projectId, projects.id))
          .where(eq(chats.id, chatId))
          .limit(1)
          .then((r) => r[0])
      : undefined,
    // Resolved whenever the body carries one — NOT gated on the absence of
    // `requestChatId`. A new chat in a project is opened at a client-allocated id
    // (/chat?projectId=… → /chat/<nanoid>) and writes no row until this very
    // request, so gating on the id meant the lookup was skipped exactly when it
    // was needed and every first send 404'd. Retargeting an existing chat is
    // already refused below, by comparing against the chat's persisted project.
    projectId
      ? db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId), projectNotDeleted)).limit(1).then((r) => r[0])
      : Promise.resolve(undefined),
  ]);

  // IDOR: chat exists but belongs to another user
  if (chatRow && chatRow.userId !== userId) {
    return Response.json({ error: "Chat not found", code: "CHAT_NOT_FOUND" }, { status: 404 });
  }
  const existingChat = chatRow?.userId === userId ? chatRow : undefined;

  // A persisted chat owns its project scope. Never let a request body retarget
  // an existing chat's task to another owned project: the worker would otherwise
  // run this chat's history against the wrong workspace, skills, and connectors.
  const persistedProjectId = existingChat?.projectId ?? undefined;
  if (existingChat && projectId !== undefined && projectId !== persistedProjectId) {
    return Response.json({ error: "Chat project does not match. Reload and try again.", code: "CHAT_PROJECT_MISMATCH" }, { status: 409 });
  }
  if (existingChat?.projectId && existingChat.projectDeletedAt) {
    return Response.json({ error: "This project is being deleted.", code: "PROJECT_DELETING" }, { status: 409 });
  }
  if (!existingChat && projectId && !project) {
    return Response.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
  }
  const effectiveProjectId = existingChat ? persistedProjectId : project?.id;

  // Telegram chats are owned by the bot channel and read-only on the web — you
  // reply from Telegram, or fork the chat to take it over on the web. Block the
  // write server-side too (defense in depth beyond the disabled composer).
  if (existingChat?.source === "telegram") {
    return Response.json({ error: "This is a Telegram chat — reply from Telegram.", code: "TELEGRAM_CHAT" }, { status: 403 });
  }

  // The chat's own model is the source of truth so the choice sticks across
  // reloads/turns; an explicit per-request model (user just switched) wins and
  // is persisted back onto the chat.
  const effectiveModel = requestModel ?? existingChat?.model ?? undefined;

  // Validate the provider/model up front so the user gets immediate feedback
  // instead of a task that fails in the background. The worker re-resolves it.
  // Its refusals (connection removed, no provider or default model, over the
  // shared-key price cap) are English ValidationErrors worded for whoever set the
  // connection up; to the composer they all mean "this model can't take the
  // message", so they travel as one code the client can put in the user's language.
  // `admin` lets the client point the one person who can fix it at Settings instead
  // of at "your admin"; the code stays the same for a page loaded before it existed.
  const resolved = await resolveUserModelInfo(userId, effectiveModel).catch((e: unknown) => {
    if (isAppError(e) && e.code === "VALIDATION_ERROR") return null;
    throw e;
  });
  if (!resolved) {
    return Response.json({ error: "This model isn't available right now.", code: "MODEL_UNAVAILABLE", admin: role === "admin" }, { status: 400 });
  }
  const { isShared, modelId: resolvedModelId, provider: resolvedProvider, configId: resolvedConfigId } = resolved;

  const text = userMessage;
  // An empty send is a regenerate, and a chat with no row yet has nothing to
  // re-answer — running it would bill a reply to the system prompt alone.
  if (!text && !existingChat) {
    return Response.json({ error: "Nothing to send.", code: "NOTHING_TO_SEND" }, { status: 400 });
  }
  // Parent linkage is server-authoritative — the client sends no history at all.
  // A normal send (parentId absent) anchors to the chat's own leaf; an edit passes
  // the sibling parent it computed from loaded history (null = first-message
  // edit); a regenerate names the user message its new reply answers.
  const parentId = text
    ? (body.parentId !== undefined ? body.parentId : (existingChat?.activeLeafId ?? null))
    : (body.parentId ?? null);
  // The parent must be a real message *in this chat* — otherwise a stale or
  // tampered client would 500 on the FK, or (with a real id from another chat)
  // silently graft this turn onto a foreign branch. A regenerate that names no
  // message comes from a client too old to know it must: send it to reload too.
  // Checked before the budget hold, so a refusal has nothing to give back.
  // Whether that parent still waits on a card the user never decided or answered is
  // read in the same lookup: this message goes past it, so it is settled below.
  let parentWaits = false;
  if (parentId || !text) {
    const [parent] = parentId
      ? await db
          .select({ id: messages.id, role: messages.role, status: sql<string | null>`${messages.metadata}->>'status'` })
          .from(messages)
          .where(and(eq(messages.id, parentId), eq(messages.chatId, chatId)))
          .limit(1)
      : [];
    if (!parent) {
      return Response.json({ error: "Conversation is out of date — please reload.", code: "STALE_CONVERSATION" }, { status: 409 });
    }
    // A regenerate re-answers a USER message. An imported chat can have a reply
    // whose predecessor is another reply (its user turn was dropped on import);
    // hanging a new reply there would send the model a transcript ending on its
    // own words, so that reply can't be regenerated — and a reload won't change it.
    if (!text && parent.role !== "user") {
      return Response.json({ error: "This reply can't be regenerated.", code: "CANNOT_REGENERATE" }, { status: 422 });
    }
    parentWaits = parent.status === "awaiting_approval" || parent.status === "awaiting_answer";
  }
  // A brand-new chat's first message can't reuse an id another row already holds.
  // The check after the message insert below refuses that too and stays the
  // race-free authority, but it runs after the chat row is written, so on its own it
  // would leave an empty "New Chat" behind.
  if (!existingChat && text && userMessageId) {
    const [taken] = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, userMessageId)).limit(1);
    if (taken) return Response.json({ error: "Message id already in use.", code: "MESSAGE_ID_IN_USE" }, { status: 409 });
  }

  // Budget gate: reserve an estimated hold for this turn up front, atomically.
  // The turn's own cost is counted before it runs (no single-turn free pass) and
  // concurrent turns across chats reserve against each other (no TOCTOU). Own-key
  // users are never gated; a shared-key turn on an unpriceable model fails closed.
  const taskId = nanoid();
  const reservation = await reserveBudget({
    userId, taskId, onSharedKey: isShared, modelId: resolvedModelId, provider: resolvedProvider,
    configId: resolvedConfigId,
  });
  if (!reservation.allowed) {
    throw new BudgetExceededError(reservation.window ?? "m1");
  }

  // The hold reserved above must be released on EVERY path that doesn't hand it to
  // a live turn — including an exception between here and enqueue. A failed
  // insert/update/enqueue would otherwise leak a pending hold that inflates the
  // budget until the orphan-hold sweep (no task row, so only its age bound) releases it.
  let handedOff = false;
  try {
  if (!existingChat) {
    await db.insert(chats).values({
      id: chatId,
      userId,
      title: "New Chat",
      model: effectiveModel ?? null,
      thinkAmount: thinkAmount ?? null,
      projectId: effectiveProjectId ?? null,
    });
  }

  // What the user chose for THIS turn. These belong to the turn, not to the user
  // message — a regenerate sends no text (it re-runs the same prompt) and so never
  // entered the `if (text)` block below, which is where they used to be written.
  // The turn still RAN on the newly-picked model (`effectiveModel` above is
  // computed outside that gate), so the chat row was left describing a different
  // model than the reply above it: the picker snapped back to the old one on
  // reload, and "the model a new chat opens with" was whatever you last *typed*
  // to rather than what you last *ran*.
  const turnSettings = {
    // Persist an explicit model switch so it sticks to this chat.
    ...(requestModel && requestModel !== existingChat?.model ? { model: requestModel } : {}),
    // Same for thinking depth — the worker reads it off the chat row, not the
    // payload, so it must land before the task is enqueued below.
    ...(thinkAmount && thinkAmount !== existingChat?.thinkAmount ? { thinkAmount } : {}),
  };

  // What the runner's reply hangs off: the user message saved just below, or the
  // one a regenerate re-answers. Derived here, from rows this request checked, so
  // the task never needs the transcript the client happens to be showing.
  let replyParentId = parentId;

  // Save user message + update chat title
  if (text) {
    const isNewChat = !existingChat || existingChat.title === "New Chat";
    const newUserId = userMessageId || nanoid();
    // Order matters: the message row must exist before the chat's
    // active_leaf_id can reference it (FK), so these can't run in parallel.
    // False when the id is some other row's.
    const save = async (exec: QueueTx) => {
      const [inserted] = await exec.insert(messages).values({
        // Reuse the client's optimistic id so the rendered bubble keeps a stable
        // React key when history reloads — otherwise it remounts and flashes.
        id: newUserId,
        chatId,
        parentId,
        role: "user",
        content: text,
        platform: "web",
        // Persist what was attached so the history bubble can show it (reference
        // metadata only — the bytes stay in the sandbox workspace).
        metadata: attachedFiles?.length ? { attachedFiles } : null,
      }).onConflictDoNothing().returning({ id: messages.id });
      // A conflict is this same send retried (another tab, a resend) — or an id that
      // is already some other row, which must not become this chat's leaf and reply
      // parent. handedOff stays false → the finally below releases the hold.
      if (!inserted) {
        const [own] = await exec
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, newUserId), eq(messages.chatId, chatId), eq(messages.role, "user")))
          .limit(1);
        if (!own) return false;
      }
      await exec.update(chats).set({
        ...(isNewChat ? { title: text.slice(0, 100) } : {}),
        ...turnSettings,
        // Point the chat at the new message so a reload mid-flight shows this
        // branch; the worker then advances it to the assistant reply.
        activeLeafId: newUserId,
        updatedAt: new Date(),
      }).where(eq(chats.id, chatId));
      return true;
    };
    // Going past a reply that still waits on the user settles it in the same
    // transaction, so its card never outlives the message that skipped it. Only then:
    // an ordinary send stays the two plain statements it always was.
    const saved = parentWaits
      ? await db.transaction(async (tx) => {
          if (!(await save(tx))) return false;
          await settleMovedPast(parentId!, tx);
          return true;
        })
      : await save(db);
    if (!saved) return Response.json({ error: "Message id already in use.", code: "MESSAGE_ID_IN_USE" }, { status: 409 });
    replyParentId = newUserId;
  } else if (existingChat) {
    // A regenerate. `updatedAt` is bumped unconditionally, not only when a setting
    // changed: it is what orders the sidebar and what `resolveInitialModel` reads
    // to answer "the model you last used", so a re-run that left it alone was an
    // act of work the whole app treated as if it had never happened.
    await db.update(chats).set({ ...turnSettings, updatedAt: new Date() }).where(eq(chats.id, chatId));
  }

  // Enqueue a durable task. The worker rebuilds model/tools/prompt from this
  // payload and runs it in the background — independent of this request.
  const payload: TaskPayload = {
    requestModel: effectiveModel,
    projectId: effectiveProjectId,
    replyParentId,
    attachedFiles: attachedFiles as FileRef[] | undefined,
  };
  // Coalesces if the chat already has a pending turn (another tab/device, a
  // queued follow-up, a stale-after-failure resend) — the message we just
  // persisted folds into that turn instead of spawning a parallel one. The
  // returned id is the turn that will actually answer, so the client's stop
  // button targets a real, live turn rather than a phantom.
  const { id: turnId, created } = await enqueueTask({ id: taskId, chatId, userId, payload });
  // A created turn now OWNS this hold and reconciles it to the real cost at
  // finalize. A folded/raced turn (created=false) does not — the finally releases
  // our hold; the turn that actually answers carries its own.
  if (created) handedOff = true;

  // Return immediately — client syncs via SSE. `deduped` says the message folded
  // into a turn that already existed rather than starting one of its own, so a
  // client can tell "queued behind the current reply" from "sent" without having
  // to compare the returned id against one it never knew.
  return Response.json({ taskId: turnId, chatId, deduped: !created });
  } finally {
    if (!handedOff) await releaseHold(taskId);
  }
});

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  const chat = await requireOwned(chats, chatId, userId, "Chat");

  // The visible conversation is the active branch (root → active leaf), with
  // each node carrying its "‹ i/N ›" sibling position for the version switcher.
  // `messageId` asks for one finished turn onward instead of the whole branch — what
  // a client already holding the rest needs after `task:finish`. An empty answer
  // means that message is not on the active branch, and the client reloads in full.
  const path = await loadActivePath(
    chatId,
    (chat.activeLeafId as string | null) ?? null,
    searchParams.get("messageId") ?? undefined,
  );
  const rows = path.map((p) => ({ ...p.node, siblingIndex: p.siblingIndex, siblingCount: p.siblingCount }));

  // What each turn saved to memory, for the "saved to memory" notice. One extra read for
  // the whole visible branch rather than one per message, and it is passed to the
  // presenter rather than merged into `rows`: this is the ONLY caller that renders the
  // notice, and the share page must never be given the shape by accident.
  const memoryWrites = await readTurnWrites(rows.map((r) => r.id), userId);
  return Response.json(toUIMessages(rows, memoryWrites));
});

// PATCH /api/chat — flip the visible branch to the prev/next version of a
// message (the "‹ i/N ›" switcher), then descend to that branch's leaf.
export const PATCH = apiHandler(async (req: Request) => {
  // requireActive: block pending/rejected from mutating chat state (branch switch);
  // navigation of one's own chat stays open to viewers.
  const { userId } = await requireActive();
  const { chatId, messageId, direction } = (await req.json()) as {
    chatId?: string;
    messageId?: string;
    direction?: "prev" | "next";
  };
  if (!chatId || !messageId || (direction !== "prev" && direction !== "next")) {
    return Response.json({ error: "Missing chatId, messageId, or direction" }, { status: 400 });
  }

  await requireOwned(chats, chatId, userId, "Chat");

  const leafId = await switchSibling(chatId, messageId, direction);
  if (!leafId) return Response.json({ error: "No sibling in that direction" }, { status: 404 });
  return Response.json({ activeLeafId: leafId });
});
