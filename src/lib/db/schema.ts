import {
  pgTable, text, boolean, timestamp, integer, jsonb, index, bigint,
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
  linkedAt: timestamp("linked_at").defaultNow(),
}, (table) => [index("idx_telegram_links_tg_user_id").on(table.telegramUserId)]);

export const linkCodes = pgTable("link_codes", {
  code: text("code").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
});

// ── Phase 1: Professional Workspace ──────────────────────────

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt"),
  defaultModel: text("default_model"),
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
