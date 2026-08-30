import {
  pgTable, text, boolean, timestamp, integer, jsonb, index, uniqueIndex, bigint, numeric,
  primaryKey, check, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  isEncrypted: boolean("is_encrypted").default(false),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false),
  image: text("image"),
  role: text("role").notNull().default("user"), // "admin" | "user" | "viewer"
  // Account lifecycle. "active" can use the app; "pending" signed in but awaiting
  // admin approval (registration_mode = "approval") — gated out of chat/key use;
  // "suspended" was approved then had access revoked by an admin (sessions killed);
  // "rejected" was denied. Non-active statuses are all fail-closed server-side.
  status: text("status").notNull().default("active"), // "active" | "pending" | "suspended" | "rejected"
  locale: text("locale"), // "en" | "uk" | null (null = follow browser/default)
  // The user's own agent profile, folded over the org ceiling the same way a
  // project's is (capProfile is a commutative minimum, so the order of the three
  // layers doesn't matter — see agents/profile.ts). Because the fold only ever
  // RESTRICTS, this can express "I don't want memory" but never "give me back what
  // the admin turned off". Only the `memory` bit is exposed in the UI today; the
  // rest of the shape is stored so a later per-user switch needs no migration.
  agentProfile: jsonb("agent_profile"),
  // IANA tz (e.g. "Europe/Kyiv"), auto-detected from the browser. null → UTC.
  // Fed into the agent's volatile prompt so it knows the user's local date/time.
  timezone: text("timezone"),
  // Spend tier governing this user's budget on the SHARED key. null → the
  // instance default tier (see tiers.isDefault). tierSource is a forward-looking
  // hook: today only "manual" (admin-assigned), later "auto" / "api".
  tierId: text("tier_id"),
  tierSource: text("tier_source").notNull().default("manual"), // "manual" | "auto" | "api"
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const providerConfigs = pgTable("provider_configs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  apiKey: text("api_key"),
  baseUrl: text("base_url"),
  defaultModel: text("default_model"),
  isActive: boolean("is_active").default(true),
  // Whether an ADMIN's connection is offered to other users on the shared key.
  // Ignored for non-admin configs (only admin keys are ever shared). Default
  // true so existing admin keys keep working as the shared pool; an admin can
  // turn it off to keep a key private to themselves.
  shared: boolean("shared").default(true),
  // Optional user-given identity for the connection — lets two configs of the
  // same provider (e.g. two LiteLLM proxies) be told apart in the picker by a
  // friendly name + brand glyph instead of an opaque host.
  label: text("label"),
  iconSlug: text("icon_slug"),
  // OpenAI transport: which wire API to drive the model over. null = "auto"
  // (real OpenAI → Responses API; a custom baseUrl → Chat Completions, since
  // OpenAI-compatible gateways implement /chat/completions only). "chat" forces
  // Chat Completions, "responses" forces the Responses API. Only the `openai`
  // provider reads this; every other provider has a single correct transport.
  apiStyle: text("api_style"),
  // User-chosen ordering of their own connections. Drives the settings list and,
  // through resolveEnabledConfigs, the order connections appear in the chat model
  // picker. Lower comes first; ties fall back to createdAt.
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [index("idx_provider_configs_user_id").on(table.userId)]);

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // FK so a chat can't reference a non-existent (or someone else's deleted)
  // project. set null (not cascade): deleting a project should orphan its chats
  // back to project-less, not delete the conversations.
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title"),
  model: text("model"),
  // How hard the model should think in this chat: "off" | "brief" | "balanced" |
  // "deep" (see models/thinking.ts). Canonical intent, NOT a provider value —
  // each provider's legal wire value is derived per model at run time. Null =
  // never set, which reads as "balanced" (the historical hardcoded behaviour).
  thinkAmount: text("think_amount"),
  // Where the conversation originates. "web" chats are fully interactive; a
  // "telegram" chat is owned by the bot channel and is read-only in the web UI
  // (you reply from Telegram, or fork it into a fresh web chat to take over).
  source: text("source").default("web"),
  pinned: boolean("pinned").default(false),
  archived: boolean("archived").default(false),
  // Sharing. "private" (default) = owner-only, the historical behaviour. "link"
  // = anyone holding the shareToken URL, including anonymous visitors. "users" =
  // only signed-in accounts of this instance. Enforced server-side on the public
  // route — never trust the client. Unpublishing flips this back to "private";
  // the token is kept so re-sharing reactivates the same URL.
  visibility: text("visibility").notNull().default("private"), // "private" | "link" | "users"
  // Unguessable public handle, minted on first publish and then stable. Null
  // until the chat has ever been shared. Unique so the public route can look a
  // chat up by token alone without exposing the owner's chat id.
  shareToken: text("share_token").unique(),
  // The leaf of the message tree currently shown. The visible conversation is
  // the chain from this leaf up to the root — switching branches is just moving
  // this pointer. Null = empty chat. FK is set-null so deleting a message never
  // orphans the chat (the read path re-derives a leaf when this is stale).
  activeLeafId: text("active_leaf_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
  // When the owner last opened this chat. Drives the sidebar's "unread reply"
  // dot: a chat is unread when it holds an assistant message newer than this.
  // Null = never opened, so any assistant reply counts as unread. Set by
  // POST /api/chats/[id]/read on open and when a watched reply finishes.
  lastReadAt: timestamp("last_read_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_chats_user_id").on(table.userId),
  index("idx_chats_project_id").on(table.projectId),
  // Default sidebar query: owner + archive bucket, ordered by pinned/activity/id.
  // The id tail also supports deterministic keyset pagination without a sort.
  index("idx_chats_sidebar").on(table.userId, table.archived, table.pinned, table.updatedAt, table.id),
]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  // Parent in the conversation tree. Null = root of the chat. Editing a message
  // or regenerating a reply inserts a *sibling* (same parent) instead of
  // deleting, so every version is preserved and reachable. Cascade so deleting a
  // node prunes its whole subtree. The tree — not created_at — defines order;
  // created_at only ranks siblings for the "‹ i/N ›" version switcher.
  parentId: text("parent_id").references((): AnyPgColumn => messages.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  platform: text("platform").default("web"),
  telegramMessageId: integer("telegram_message_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_messages_chat_id").on(table.chatId),
  index("idx_messages_created_at").on(table.createdAt),
  index("idx_messages_parent_id").on(table.parentId),
  // Sidebar unread probe: assistant messages newer than last_read_at per chat.
  index("idx_messages_chat_role_created").on(table.chatId, table.role, table.createdAt),
]);

/**
 * What a reply has ALREADY DONE — one row per tool call that actually ran.
 *
 * Deliberately NOT in `messages.metadata`: that blob is replaced wholesale by
 * every snapshot and by finalization, so an emergency trim which clears `parts`
 * erases the only evidence a call ran, and the task that continues the reply then
 * repeats a write that is not idempotent.
 *
 * Keyed by MESSAGE, not by task, because the message is the ledger's real
 * lifetime: an approval or `ask` continuation is a second task writing this same
 * row, so keying by task would split one turn's ledger in half. `producer_task_id`
 * keeps that provenance without claiming ownership.
 *
 * Bound: the cascade IS the inverse. An entry cannot outlive the reply it
 * describes, so pruning a message — or its chat — prunes its effects with it, and
 * the table needs no retention pass of its own.
 */
export const messageEffects = pgTable("message_effects", {
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  /** The SDK's tool-call id. What makes re-running one approved call idempotent
   *  here: the second outcome replaces the first instead of adding an entry. */
  toolCallId: text("tool_call_id").notNull(),
  producerTaskId: text("producer_task_id"),
  toolName: text("tool_name").notNull(),
  input: jsonb("input"),
  /** The call threw. It still RAN — a tool that writes before it fails has already
   *  written — which makes this the entry a restarted turn most needs to verify. */
  failed: boolean("failed").notNull().default(false),
  /**
   * False between dispatch and outcome: the row was written just before the tool was
   * entered, so it means "this may have run" rather than "this ran".
   *
   * The window it exists to describe is the one a result-time-only ledger cannot: the
   * tool starts, the worker dies, and nothing anywhere records that the workspace may
   * already have been touched. Defaults to true so every row written before this
   * column existed keeps its original meaning — those were all recorded on a result
   * or an error, which is exactly what settled means.
   */
  settled: boolean("settled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.toolCallId] }),
]);

export const telegramLinks = pgTable("telegram_links", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull().unique(),
  telegramUsername: text("telegram_username"),
  // The chat Telegram messages flow into. Pinning it (instead of "last updated
  // chat") stops Telegram replies from leaking into web/project chats and keeps
  // project context (files + memory) consistent across both channels.
  activeChatId: text("active_chat_id").references(() => chats.id, { onDelete: "set null" }),
  linkedAt: timestamp("linked_at").defaultNow(),
}, (table) => [index("idx_telegram_links_tg_user_id").on(table.telegramUserId)]);

export const linkCodes = pgTable("link_codes", {
  code: text("code").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
});

// ── Background Tasks ─────────────────────────────────────────

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  // FK so a deleted user's tasks don't orphan (and their pending holds can't
  // linger unreleasable). Cascade matches chats/messages.
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"), // queued, running, completed, failed, cancelled
  error: text("error"),
  // Self-contained run payload so any worker can execute the task without the
  // originating request's in-memory state (chatId, model id, system prompt, etc.).
  payload: jsonb("payload"),
  // Durable-queue bookkeeping (FOR UPDATE SKIP LOCKED + lease/heartbeat).
  leaseExpiresAt: timestamp("lease_expires_at"),
  heartbeatAt: timestamp("heartbeat_at"),
  workerId: text("worker_id"),
  cancelRequested: boolean("cancel_requested").default(false),
  attempts: integer("attempts").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_tasks_chat_id").on(table.chatId),
  index("idx_tasks_chat_status").on(table.chatId, table.status),
  index("idx_tasks_user_id_status").on(table.userId, table.status),
  index("idx_tasks_status_lease").on(table.status, table.leaseExpiresAt),
  index("idx_tasks_status_created").on(table.status, table.createdAt),
  // One pending turn per chat, enforced by the DB itself — the invariant the
  // whole queue rests on. A chat's turns are serialized (claimNextTask won't
  // start one while another is live), so a follow-up sent while the chat is
  // busy must FOLD into the single pending continuation, never spawn a second
  // independent turn. Without a hard constraint that "fold" lived only in client
  // logic, so any state the client couldn't see — another tab, a phone, a
  // Telegram message, a stale-after-failure UI — slipped a parallel turn past it
  // (the chat that "duplicated itself and ran different tasks"). This partial
  // unique index makes the duplicate physically impossible no matter how many
  // tabs/devices/workers race; enqueueTask leans on it via ON CONFLICT to
  // coalesce instead of insert. Partial (status='queued') so it constrains only
  // pending rows — running/finished tasks accumulate freely as history.
  uniqueIndex("uq_tasks_one_queued_per_chat").on(table.chatId).where(sql`status = 'queued'`),
]);

// Per-task / per-message token usage and cost, captured at finalize time.
export const usage = pgTable("usage", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  messageId: text("message_id"),
  // FK so a deleted user's spend rows don't linger as orphans that still sum into
  // org totals (admin/usage LEFT JOINs user). Cascade matches every other
  // user-owned table; the row is history that dies with the user.
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  // WHICH connection spent it. `provider` is only the kind (litellm / azure / …),
  // so two configs of the same kind — two proxies, two departments' keys — are
  // indistinguishable without this. set null (not cascade): the spend is history
  // and must outlive the connection being disconnected; the breakdown just shows
  // it as unattributed. Null is also every row written before this column existed.
  configId: text("config_id").references(() => providerConfigs.id, { onDelete: "set null" }),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cachedInputTokens: integer("cached_input_tokens").default(0),
  // Fixed precision/scale: this is the money ledger. An unconstrained numeric let
  // JS-float round-trips store absurd-precision strings; pin it to 8 decimals.
  costUsd: numeric("cost_usd", { precision: 18, scale: 8 }),
  // Whether this spend hit the shared (admin) key vs the user's own key. Only
  // shared-key spend counts against a user's budget — own-key users pay their
  // own provider directly, so they're never throttled.
  onSharedKey: boolean("on_shared_key").default(false),
  // A "hold": an estimated reservation written at the budget gate BEFORE a turn
  // runs, then reconciled to the real cost (pending=false) at finalize, or
  // released if the turn never runs. Pending rows count toward the budget so
  // concurrent turns reserve against each other (no check-then-spend race).
  pending: boolean("pending").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("idx_usage_user_created").on(t.userId, t.createdAt),
  index("idx_usage_model").on(t.model),
  // The admin "spend by connection" breakdown: group by config within a period.
  index("idx_usage_config_created").on(t.configId, t.createdAt),
  // Reconcile/release look a hold up by task id; keep that lookup cheap.
  index("idx_usage_task_pending").on(t.taskId, t.pending),
  // At most ONE outstanding hold per task. reconcileUsage settles holds by task id,
  // so a duplicate pending row would record the real cost N times (the billing leak
  // the chat-route try/finally guards against — this makes it structurally
  // impossible). reserveBudget inserts ON CONFLICT DO NOTHING against this index.
  uniqueIndex("uq_usage_one_pending_per_task").on(t.taskId).where(sql`pending`),
]);

// ── Spend tiers ──────────────────────────────────────────────
// A named set of budget caps applied per-user to SHARED-key spend, evaluated
// over three rolling windows (5h / 7d / 30d). A null cap means "unlimited" for
// that window. Exactly one row is the instance default (isDefault), used for any
// user without an explicit tierId. Today the admin edits the default tier and
// may hand-assign others; multi-tier management is a later iteration.
export const tiers = pgTable("tiers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  limit5h: numeric("limit_5h", { precision: 18, scale: 8 }), // USD cap over the last 5 hours (null = unlimited)
  limitWeek: numeric("limit_week", { precision: 18, scale: 8 }), // USD cap over the last 7 days
  limitMonth: numeric("limit_month", { precision: 18, scale: 8 }), // USD cap over the last 30 days
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [index("idx_tiers_is_default").on(t.isDefault)]);

// ── Model catalog ────────────────────────────────────────────
// Synced from OpenRouter (primary) + LiteLLM (fallback) so models, names,
// grouping and prices are never hardcoded. Drives both the model picker and
// usage cost. Admin curation (enabled/featured) survives re-syncs.
export const models = pgTable("models", {
  id: text("id").primaryKey(), // canonical id, e.g. "anthropic/claude-opus-4.1"
  source: text("source").notNull(), // "openrouter" | "litellm"
  displayName: text("display_name").notNull(), // "Anthropic: Claude Opus 4.1"
  group: text("group"), // company, e.g. "Anthropic"
  icon: text("icon"), // brand slug for the UI, e.g. "anthropic"
  contextLength: integer("context_length"),
  inputPrice: numeric("input_price", { precision: 20, scale: 12 }), // USD per token (tiny — needs deep scale)
  outputPrice: numeric("output_price", { precision: 20, scale: 12 }),
  cacheReadPrice: numeric("cache_read_price", { precision: 20, scale: 12 }),
  // Writing a prompt-cache entry is billed ABOVE base input (Anthropic: 1.25x at
  // the 5-minute TTL, 2x at one hour). Both price books report the real figure, so
  // it is synced like any other price rather than derived from a multiplier here.
  cacheWritePrice: numeric("cache_write_price", { precision: 20, scale: 12 }),
  capabilities: jsonb("capabilities"), // { vision, tools, reasoning }
  cutoff: text("cutoff"), // knowledge cutoff, e.g. "2025-03" (from Models.dev)
  openWeights: boolean("open_weights"), // open-weights model? (from Models.dev)
  enabled: boolean("enabled").default(false), // visible in picker (curated)
  featured: boolean("featured").default(false), // pinned to the top
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("idx_models_group").on(t.group),
  index("idx_models_enabled").on(t.enabled),
]);

// ── Phase 1: Professional Workspace ──────────────────────────

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt"),
  defaultModel: text("default_model"),
  sandboxNetwork: text("sandbox_network").default("none"), // "none" | "bridge"
  // The project's agent profile: which capability groups its agent may use, and
  // how the system prompt is composed around `systemPrompt` above. null = Capka's
  // normal assistant behaviour. One jsonb column rather than a boolean per knob
  // deliberately — see src/lib/agents/profile.ts: every field is defaulted, so a
  // new capability group parses forward on old rows and ships without a migration.
  agentProfile: jsonb("agent_profile"),
  // Tombstone for durable deletion. A non-null value hides the project from every
  // query (all reads filter `deleted_at is null`) the instant the delete transaction
  // commits, while the physical row + its cascades survive until post-commit teardown
  // (kill sandbox, wipe workspace, detach folders) succeeds. A worker tick retries
  // teardown for any row left tombstoned by a failed attempt, so there is never a
  // state where the project is visible without its files or its files outlive the row.
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_projects_user_id").on(table.userId),
  // Partial index over just the tombstoned rows — the worker's teardown-retry scan
  // (deleted_at is not null) stays cheap without indexing the all-null common case.
  index("idx_projects_deleted_at").on(table.deletedAt).where(sql`deleted_at is not null`),
]);

// ── Automations (scheduled agent runs) ───────────────────────

/** A recurring (or one-off) agent run the platform fires without an open tab.
 *  Each firing materializes a NEW ordinary chat with one user message (the
 *  prompt) and enqueues a normal task — see src/lib/automations/runs.ts. The
 *  scheduler is a tick in the in-process worker; rows are claimed with
 *  FOR UPDATE SKIP LOCKED so multiple platform replicas can't double-fire. */
export const automations = pgTable("automations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Inherited from the chat where the automation was created: run chats get the
  // same projectId, so they share the project's sandbox (workspace continuity).
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  // The user message each run starts with — the whole instruction.
  prompt: text("prompt").notNull(),
  // Model of the creating chat; null → default resolution in the runner.
  model: text("model"),
  // {kind:"schedule", cron, timezone} | {kind:"once", at} — see AutomationTrigger.
  trigger: jsonb("trigger").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  nextRunAt: timestamp("next_run_at"),
  lastRunAt: timestamp("last_run_at"),
  // The task the last firing enqueued: overlap guard (skip firing while it's
  // still queued/running) + "open last run" links in settings/debug.
  lastTaskId: text("last_task_id"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_automations_user_id").on(table.userId),
  // The scheduler's whole query: due, enabled rows.
  index("idx_automations_due").on(table.nextRunAt).where(sql`enabled = true`),
]);

/** A folder attached to a sandbox session (key = projectId ?? chatId — chats in a
 *  project share it). kind "host" = a server directory bind-mounted at /folders/
 *  <name> (admin-only, validated by the controller's mount-safety); kind "pc" = a
 *  folder on the user's own computer synced by the browser bridge into
 *  /workspace/<name>. `state` holds the pc-sync base manifest (3-way merge). */
export const attachedFolders = pgTable("attached_folders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionKey: text("session_key").notNull(),
  kind: text("kind").notNull(), // "host" | "pc"
  name: text("name").notNull(),
  hostPath: text("host_path"),
  readOnly: boolean("read_only").notNull().default(true),
  state: jsonb("state"),
  // Server-side sync lease so two tabs / project members can't run destructive
  // file operations against the same folder at once (the state CAS only protects
  // the merge-ancestor row, not the files already touched). `{ token, expiresAt }`;
  // NULL or expired = free. Held for one sync, cleared on completion, and
  // self-expiring so a crashed client never locks the folder permanently.
  syncLease: jsonb("sync_lease").$type<{ token: string; expiresAt: string } | null>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("uq_attached_folders_session_name").on(table.sessionKey, table.name),
  index("idx_attached_folders_session").on(table.sessionKey),
]);

// Agent memory as ONE self-maintaining markdown document per scope — "CLAUDE.md
// in Postgres". `projectId IS NULL` is the user-global doc (≈ ~/CLAUDE.md); a row
// with a projectId is that project's doc (≈ project/CLAUDE.md). The doc is edited
// by line-level reconcile ops after each turn, periodically consolidated, and is
// hand-editable in settings. `version` drives optimistic concurrency (two chats
// in one project can race the same doc); `prevContent` is one step of undo so a
// bad consolidation rewrite is recoverable.
export const memoryDocs = pgTable("memory_docs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  content: text("content").notNull().default(""),
  prevContent: text("prev_content"),
  version: integer("version").notNull().default(0),
  turnsSinceConsolidation: integer("turns_since_consolidation").notNull().default(0),
  // Stamped once this doc's content has been carried into the vault's claims.
  // Null = the doc is still the only home of that memory.
  migratedAt: timestamp("migrated_at"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // One doc per scope. NULL projectId is "distinct" under a plain UNIQUE, so the
  // user-global row needs its own partial unique index (enforced in the migration).
  uniqueIndex("uniq_memory_docs_user_project").on(table.userId, table.projectId),
  index("idx_memory_docs_user_id").on(table.userId),
]);


// Anthropic-compatible Agent Skills. Scope tiers: 'system' (whole deployment),
// 'user' (one user, all projects), 'project' (one project). Precedence on name
// collision is resolved in the service layer (project > user > system).
export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(), // 'system' | 'user' | 'project'
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  body: text("body").notNull(),
  frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>().default({}),
  source: text("source").notNull().default("manual"), // 'manual' | later 'catalog:<id>'
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_skills_user_id").on(table.userId),
  index("idx_skills_project_id").on(table.projectId),
  index("idx_skills_scope").on(table.scope),
]);

// Per-user opt-out of a SHARED resource (a system/project skill or connector).
// A row means "this user turned this shared item off for themselves" — the
// admin's global enable stays on for everyone else. Absence = on. Users can't
// force-enable something the admin disabled globally; this only mutes.
export const userMutedResources = pgTable("user_muted_resources", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // 'skill' | 'mcp'
  resourceId: text("resource_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.kind, table.resourceId] }),
  index("idx_user_muted_user").on(table.userId),
]);

// Bundled files (scripts/, references) — base64 content. SKILL.md body lives in
// skills.body; this table holds everything else, materialized into the sandbox
// on demand. Postgres is the source of truth (no separate file store).
export const skillFiles = pgTable("skill_files", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  content: text("content").notNull(), // base64
}, (table) => [index("idx_skill_files_skill_id").on(table.skillId)]);

// Remote MCP connectors (sub-project B). Scope mirrors skills: system=org-shared
// credential, user=personal, project=project-scoped. The credential lives on the
// row, so its reach equals the row's scope. `secrets` is AES-GCM ciphertext of
// { headers?, env? } (env reserved for stdio/B2). `transport` stores http|sse|stdio
// but the service serves only 'http' in B1.
export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(), // 'system' | 'user' | 'project'
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // namespace ^[a-z0-9]+(-[a-z0-9]+)*$
  transport: text("transport").notNull().default("http"), // 'http' | 'sse' | 'stdio'
  url: text("url"),
  command: text("command"), // stdio (B2)
  args: jsonb("args").$type<string[]>().default([]),
  secrets: text("secrets"), // AES-GCM ciphertext of { headers?, env? }
  authKind: text("auth_kind").notNull().default("token"), // 'token' | 'oauth'
  enabled: boolean("enabled").notNull().default(true),
  source: text("source").notNull().default("manual"), // 'manual' | 'catalog:<id>'
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_mcp_servers_user_id").on(table.userId),
  index("idx_mcp_servers_project_id").on(table.projectId),
  index("idx_mcp_servers_scope").on(table.scope),
]);

// OAuth DCR / pre-registered client, per SERVER (shared by all users — the client
// is registered with that server's authorization server, not per person).
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  serverId: text("server_id").primaryKey().references(() => mcpServers.id, { onDelete: "cascade" }),
  clientInfo: text("client_info").notNull(), // AES-GCM JSON: OAuthClientInformationFull
  createdAt: timestamp("created_at").defaultNow(),
});

// The per-USER OAuth credential for a server (each employee signs in with their
// own account, even on a shared `system` connector).
export const mcpOauthTokens = pgTable("mcp_oauth_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: text("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  tokens: text("tokens").notNull(), // AES-GCM JSON: OAuthTokens
  account: text("account"), // optional display label
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_mcp_oauth_tokens_user").on(table.userId),
  index("idx_mcp_oauth_tokens_server").on(table.serverId),
]);

// Short-lived in-flight authorization (one redirect round-trip). Single-use + TTL.
export const mcpOauthStates = pgTable("mcp_oauth_states", {
  state: text("state").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serverId: text("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  codeVerifier: text("code_verifier").notNull(), // AES-GCM PKCE verifier
  createdAt: timestamp("created_at").defaultNow(),
});

// A Claude plugin marketplace the admin trusts (a GitHub repo with
// .claude-plugin/marketplace.json). `catalog` caches its normalized plugin list.
export const pluginMarketplaces = pgTable("plugin_marketplaces", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  name: text("name").notNull(),
  owner: text("owner"),
  catalog: jsonb("catalog").$type<unknown[]>().default([]),
  // Created by an install rather than added by an admin: `manage skill add {repo}` models a
  // bare skills repo as a one-plugin marketplace because `plugin_installs` needs a parent
  // row. That row is plumbing, not a catalog anyone chose to offer, so it stays out of the
  // Browse list — otherwise any member's personal install silently edits what the whole
  // organization sees. An admin adding the same URL adopts the row and clears the flag.
  synthetic: boolean("synthetic").notNull().default(false),
  refreshedAt: timestamp("refreshed_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

// A record of an installed plugin, for uninstall + status. Routed skills/connectors
// carry `source = 'catalog:<this id>'` so uninstall deletes exactly what we added.
export const pluginInstalls = pgTable("plugin_installs", {
  id: text("id").primaryKey(),
  marketplaceId: text("marketplace_id").notNull().references(() => pluginMarketplaces.id, { onDelete: "cascade" }),
  pluginName: text("plugin_name").notNull(),
  version: text("version"), // human-facing version from plugin.json (or the ref), display only
  commitSha: text("commit_sha"), // the git commit the install is PINNED to (provenance + supply-chain pin)
  scope: text("scope").notNull().default("system"), // 'system' (org-wide) | 'user' (personal)
  // Owner for a personal (scope=user) install — cascades so a member's installs go
  // with them. Null for system installs. `installedBy` stays the audit actor.
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().default({}),
  installedBy: text("installed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_plugin_installs_marketplace").on(table.marketplaceId),
  index("idx_plugin_installs_user").on(table.userId),
  // The staging insert IS the first-install claim. Without these, two parallel first
  // installs both pass the existence check and both insert with different ids — the
  // "idempotent per (marketplace, plugin, owner)" property held only in the absence of
  // concurrency. Partial because `user_id IS NULL` for a system install and
  // `NULL != NULL` in a plain unique index, so one index cannot cover both scopes.
  uniqueIndex("uq_plugin_installs_system").on(table.marketplaceId, table.pluginName, table.scope).where(sql`user_id is null`),
  uniqueIndex("uq_plugin_installs_user").on(table.marketplaceId, table.pluginName, table.scope, table.userId).where(sql`user_id is not null`),
]);

// Bundled plugin files (servers/, scripts/, config) — base64 content, materialized
// into the sandbox at /plugins/<installId> on demand so a plugin's local MCP server
// referencing ${CLAUDE_PLUGIN_ROOT} can run. Mirrors skillFiles; Postgres is the
// source of truth. Cascade-dropped with the install (which is the uninstall path).
export const pluginFiles = pgTable("plugin_files", {
  id: text("id").primaryKey(),
  installId: text("install_id").notNull().references(() => pluginInstalls.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  content: text("content").notNull(), // base64
}, (table) => [index("idx_plugin_files_install_id").on(table.installId)]);

// Unified permission policy over skills + connectors. Default (no row) = allow.
// G1 enforces allow/deny at tool-assembly; 'ask' is stored for the future gate.
export const capabilityPolicies = pgTable("capability_policies", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull().default("system"), // 'system' | 'user' | 'project'
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  capabilityType: text("capability_type").notNull(), // 'skill' | 'connector'
  capabilityKey: text("capability_key").notNull(), // skill name / connector name
  effect: text("effect").notNull(), // 'allow' | 'deny' | 'ask'
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  /**
   * Compare-and-set token for a plugin apply that also moves a policy: one value covers
   * every column at once, so the CAS cannot be under-specified the way a field list can
   * (the policy's identity spans five columns plus `effect`, two of them nullable).
   *
   * Not `updated_at`, even though it already exists: `setPolicy` writes it as
   * `new Date()` — millisecond precision, no monotonicity — so two updates inside one
   * millisecond produce an identical value and the CAS sees no change. A database
   * default would be WORSE, because `now()` is transaction-start time and two updates in
   * one transaction would then be identical by construction. Bumped only in `setPolicy`;
   * `clearPolicy` needs no bump because the row goes.
   */
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
}, (table) => [
  index("idx_capability_policies_type").on(table.capabilityType),
  index("idx_capability_policies_scope").on(table.scope),
  // One rule per capability per subject, per scope — otherwise concurrent upserts
  // duplicate rows and the matcher becomes nondeterministic. Partial so each scope
  // keys off only its own subject column.
  uniqueIndex("uq_capability_policies_system").on(table.capabilityType, table.capabilityKey).where(sql`scope = 'system'`),
  uniqueIndex("uq_capability_policies_user").on(table.userId, table.capabilityType, table.capabilityKey).where(sql`scope = 'user'`),
  uniqueIndex("uq_capability_policies_project").on(table.projectId, table.capabilityType, table.capabilityKey).where(sql`scope = 'project'`),
  // The subject columns must match the scope: system has neither, user has only a
  // user, project has only a project. Keeps the three scopes from blurring.
  check("ck_capability_policies_subject", sql`
    (scope = 'system' and user_id is null and project_id is null) or
    (scope = 'user' and user_id is not null and project_id is null) or
    (scope = 'project' and project_id is not null and user_id is null)
  `),
]);

// Append-only audit trail of governance-relevant actions.
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetKey: text("target_key"),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_audit_log_created").on(table.createdAt),
  index("idx_audit_log_action").on(table.action),
]);

// Server-staged, single-use, short-TTL confirmations for the chat-driven `manage`
// control plane. A risky change (org setting, connector/skill add/remove) is
// STAGED here and applied only by a human-controlled path — the web Confirm
// button (session cookie) or a Telegram callback — so the model, which never
// sees this row's id in a replayable form, cannot apply a change on its own
// (defeating prompt-injection self-confirm). `payload` holds the exact mutation
// to run, so the applied change can't be swapped for a different one.
export const managePending = pgTable("manage_pending", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id"), // captured at stage time; apply runs in the same scope
  kind: text("kind").notNull(), // "apply" | "undo"
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"), // single-use latch
}, (table) => [
  index("idx_manage_pending_expires").on(table.expiresAt),
]);

// A pending MCP elicitation. Elicitation arrives mid-`callTool` over a live MCP
// connection, so — unlike the durable `ask` suspend — it can't snapshot/resume:
// the handler BLOCKS and polls this row until the user answers (`answer` set) or
// it times out (row deleted). `form` is the AskForm the card renders; `answer` is
// the AskAnswer the user submits. Matched by `messageId` (the assistant turn the
// blocked tool belongs to) + `userId` (only the owner may answer). Short-lived.
export const pendingElicitations = pgTable("pending_elicitation", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id").notNull(),
  userId: text("user_id").notNull(),
  form: jsonb("form").$type<Record<string, unknown>>().notNull(),
  answer: jsonb("answer").$type<Record<string, unknown>>(), // AskAnswer once answered; null while pending
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_pending_elicitation_message").on(table.messageId),
]);

// ── Vault: the canonical store for knowledge and memory (spec 2026-08-29) ──────
//
// One cascade chain, one stopper: spaces → knowledge_sources → versions →
// fragments all CASCADE, and the ONLY thing that can hold any of it back is a
// `message_citations` row (RESTRICT on both the version and the fragment). So a
// space DELETE either goes all the way through or aborts whole — a citation is
// the single pin. `claim_evidence.fragment_id` is deliberately SET NULL: an
// evidence row keeps its own quote snapshot, so it is a record, not a pin.

export const spaces = pgTable("spaces", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["user", "project"] }).notNull(),
  refId: text("ref_id").notNull(), // users.id | projects.id — polymorphic, no FK
  // Denormalized owner: on user deletion, purge also finds the spaces of LONG-deleted
  // projects, whose projects row no longer exists by then.
  ownerUserId: text("owner_user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  // The space's TERMINAL state. A project's space row outlives the project (ref_id is
  // polymorphic, so no cascade reaches it, and a cited source version must survive),
  // which means "this project is gone" cannot be read off the projects table — and a
  // post-turn extraction that returns after the delete would otherwise write a fact
  // into memory the user believes they destroyed. Set by `retireProjectSpace`, read
  // under a row lock by every write into the space (`spaceAcceptsWrites`).
  retiredAt: timestamp("retired_at"),
}, (t) => [
  uniqueIndex("uniq_spaces_type_ref").on(t.type, t.refId),
  index("idx_spaces_owner").on(t.ownerUserId),
]);

export const knowledgeSources = pgTable("knowledge_sources", {
  id: text("id").primaryKey(),
  spaceId: text("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  origin: jsonb("origin").notNull(),          // the recipe: {type:"upload"|"url"|"mcp"|"chat", ...}
  labels: jsonb("labels").notNull().default([]), // string[]
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  deletedAt: timestamp("deleted_at"),         // SOFT delete: cited versions have to survive
}, (t) => [index("idx_ksources_space").on(t.spaceId)]);

export const knowledgeSourceVersions = pgTable("knowledge_source_versions", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull().references(() => knowledgeSources.id, { onDelete: "cascade" }),
  sha256: text("sha256").notNull(),           // the original's CAS key
  observedAt: timestamp("observed_at").notNull().defaultNow(),
  parser: jsonb("parser").notNull().default({}), // {name, version, profile}
  // Contract: { [kind: string]: { sha256: string, bytes: number, producedAt: string } }
  representations: jsonb("representations").notNull().default({}),
  status: text("status", { enum: ["ingesting", "ready", "error"] }).notNull().default("ingesting"),
  error: text("error"),
  supersededAt: timestamp("superseded_at"),   // a new version sets this on the old one; rows are immutable
}, (t) => [
  index("idx_ksv_source").on(t.sourceId),
  // NOT unique: the spec allows a fresh parse of the SAME bytes (a fast→deep upgrade,
  // a new parser) to be a NEW version with new fragments — immutability and citation
  // pinning rest on exactly that. Re-fetch idempotency is the ingest logic's problem
  // (plan B).
  index("idx_ksv_source_sha").on(t.sourceId, t.sha256),
]);

export const knowledgeFragments = pgTable("knowledge_fragments", {
  id: text("id").primaryKey(),                // a stable UUID — citations point at it
  versionId: text("version_id").notNull().references(() => knowledgeSourceVersions.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  text: text("text").notNull(),
  language: text("language"),                 // CONTRACT: lowercase ISO 639-1/2 ("uk","en"); ingest validates it (plan B)
  locator: jsonb("locator").notNull(),        // {scheme, version, anchor, display, fallback}
}, (t) => [uniqueIndex("uniq_kfrag_version_ordinal").on(t.versionId, t.ordinal)]);

export const vaultNotes = pgTable("vault_notes", {
  id: text("id").primaryKey(),
  spaceId: text("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),   // md; fact lists are a projection of note_claims, body does NOT duplicate them
  kind: text("kind", { enum: ["note", "memory_topic", "index"] }).notNull().default("note"),
  // The topic's IDENTITY, and the reason it is not `title`. `getOrCreateTopicNote`
  // used to resolve on the title, so the title was simultaneously a database key and a
  // user-visible string — and renaming the default topic from one language to another
  // FORKED every topic that existed, leaving two notes holding the same claims and the
  // prompt manifest counting both. A value a translator may touch is never a key.
  // Nullable because plain notes (`kind: "note"`, plan D2) have no key; the partial
  // unique index below is what makes it required in practice for a memory topic, and
  // `getOrCreateTopicNote` is the only writer of one.
  topicKey: text("topic_key"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("idx_vnotes_space").on(t.spaceId),
  // Identity uniqueness applies ONLY to memory topics, and to the KEY. Two topics may
  // legitimately end up showing the same title (a user-named one colliding with a
  // built-in label); they may not share a key.
  uniqueIndex("uniq_vnotes_memory_topic").on(t.spaceId, t.topicKey).where(sql`${t.kind} = 'memory_topic'`),
]);

export const vaultClaims = pgTable("vault_claims", {
  id: text("id").primaryKey(),
  spaceId: text("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  statement: text("statement").notNull(),
  slotKey: text("slot_key"),                  // advisory; the aux normalizer canonicalizes it (plan C)
  value: jsonb("value"),                      // the structured value (from the tool's JSON string)
  kind: text("kind").notNull().default("fact"),
  origin: jsonb("origin").notNull(),          // Provenance (Task 5)
  reviewStatus: text("review_status", { enum: ["unverified", "confirmed"] }).notNull().default("unverified"),
  sensitive: boolean("sensitive").notNull().default(false),
  validFrom: timestamp("valid_from"),
  validTo: timestamp("valid_to"),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  revision: integer("revision").notNull().default(1),
  supersedes: text("supersedes"),             // the predecessor's vault_claims.id (no FK: the chain outlives a forget)
  supersededAt: timestamp("superseded_at"),   // non-NULL = not the head; the text is NEVER UPDATEd
}, (t) => [
  index("idx_vclaims_space_head").on(t.spaceId, t.supersededAt),
  index("idx_vclaims_supersedes").on(t.supersedes),
  // One active head per slot:
  uniqueIndex("uniq_vclaims_active_slot").on(t.spaceId, t.slotKey)
    .where(sql`${t.supersededAt} IS NULL AND ${t.slotKey} IS NOT NULL`),
  // One successor per claim (a supersede race loses at the insert, not silently):
  uniqueIndex("uniq_vclaims_one_successor").on(t.supersedes).where(sql`${t.supersedes} IS NOT NULL`),
]);

export const noteClaims = pgTable("note_claims", {
  noteId: text("note_id").notNull().references(() => vaultNotes.id, { onDelete: "cascade" }),
  claimId: text("claim_id").notNull().references(() => vaultClaims.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [
  uniqueIndex("uniq_note_claims").on(t.noteId, t.claimId),
  index("idx_note_claims_claim").on(t.claimId),
]);

export const claimEvidence = pgTable("claim_evidence", {
  id: text("id").primaryKey(),
  claimId: text("claim_id").notNull().references(() => vaultClaims.id, { onDelete: "cascade" }),
  relation: text("relation", { enum: ["supports", "refutes", "derived_from"] }).notNull().default("supports"),
  fragmentId: text("fragment_id").references(() => knowledgeFragments.id, { onDelete: "set null" }),
  messageId: text("message_id"),
  quoteSnapshot: text("quote_snapshot"),
  locatorSnapshot: jsonb("locator_snapshot"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [index("idx_cev_claim").on(t.claimId)]);

export const memoryCandidates = pgTable("memory_candidates", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  spaceId: text("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  originMessageId: text("origin_message_id"),
  statement: text("statement").notNull(),
  slotKey: text("slot_key"),
  value: jsonb("value"),
  provenance: jsonb("provenance").notNull(),
  evidence: jsonb("evidence").notNull().default([]), // EvidenceInput[]: a pending candidate has no claim yet — evidence waits here
  sensitive: boolean("sensitive").notNull().default(false),
  policyState: text("policy_state", { enum: ["auto_active", "pending", "denied", "conflict"] }).notNull(),
  claimId: text("claim_id"),
  conflictsWith: text("conflicts_with"),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (t) => [
  uniqueIndex("uniq_mcand_idem").on(t.idempotencyKey),
  index("idx_mcand_unresolved").on(t.spaceId).where(sql`${t.resolvedAt} IS NULL`),
]);

export const messageCitations = pgTable("message_citations", {
  id: text("id").primaryKey(),                // the UUID IS /citations/<uuid> (plan C)
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  // INVARIANT (held by the minting service, plan C): sourceVersionId is ALWAYS derived
  // from fragment.versionId at write time — never accepted separately, or the pair can
  // drift across versions. A cross-table CHECK is impossible in PG; plan C adds a test.
  sourceVersionId: text("source_version_id").notNull().references(() => knowledgeSourceVersions.id, { onDelete: "restrict" }),
  fragmentId: text("fragment_id").notNull().references(() => knowledgeFragments.id, { onDelete: "restrict" }),
  quoteSnapshot: text("quote_snapshot").notNull(),
  locatorSnapshot: jsonb("locator_snapshot").notNull(),
  titleSnapshot: text("title_snapshot").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("uniq_mcit_msg_ordinal").on(t.messageId, t.ordinal),
  index("idx_mcit_fragment").on(t.fragmentId),
]);

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  spaceId: text("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  actor: jsonb("actor").notNull(),            // {kind:"user"|"agent"|"system", id?}
  action: text("action").notNull(),           // claim.create | claim.supersede | claim.forget | candidate.propose | ...
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [index("idx_audit_space_created").on(t.spaceId, t.createdAt)]);
