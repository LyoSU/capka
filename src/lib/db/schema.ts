import {
  pgTable, text, boolean, timestamp, integer, jsonb, index, bigint, numeric,
} from "drizzle-orm/pg-core";

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
  locale: text("locale"), // "en" | "uk" | null (null = follow browser/default)
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
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [index("idx_provider_configs_user_id").on(table.userId)]);

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id"),
  title: text("title"),
  model: text("model"),
  pinned: boolean("pinned").default(false),
  archived: boolean("archived").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_chats_user_id").on(table.userId),
  index("idx_chats_project_id").on(table.projectId),
]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  platform: text("platform").default("web"),
  telegramMessageId: integer("telegram_message_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_messages_chat_id").on(table.chatId),
  index("idx_messages_created_at").on(table.createdAt),
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
  userId: text("user_id").notNull(),
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
  index("idx_tasks_user_id_status").on(table.userId, table.status),
  index("idx_tasks_status_lease").on(table.status, table.leaseExpiresAt),
]);

// Per-task / per-message token usage and cost, captured at finalize time.
export const usage = pgTable("usage", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  messageId: text("message_id"),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cachedInputTokens: integer("cached_input_tokens").default(0),
  costUsd: numeric("cost_usd"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("idx_usage_user_created").on(t.userId, t.createdAt),
  index("idx_usage_model").on(t.model),
]);

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
  inputPrice: numeric("input_price"), // USD per token
  outputPrice: numeric("output_price"),
  cacheReadPrice: numeric("cache_read_price"),
  capabilities: jsonb("capabilities"), // { vision, tools, reasoning }
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
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [index("idx_projects_user_id").on(table.userId)]);

export const memories = pgTable("memories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  type: text("type").notNull().default("fact"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_memories_user_id").on(table.userId),
  index("idx_memories_project_id").on(table.projectId),
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
  enabled: boolean("enabled").notNull().default(true),
  source: text("source").notNull().default("manual"), // 'manual' | 'catalog:<id>'
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_mcp_servers_user_id").on(table.userId),
  index("idx_mcp_servers_project_id").on(table.projectId),
  index("idx_mcp_servers_scope").on(table.scope),
]);
