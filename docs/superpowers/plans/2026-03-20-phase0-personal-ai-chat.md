# Phase 0: Personal AI Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Working AI chat platform with MCP tools, Telegram sync, zero config files — all setup via web UI wizard.

**Architecture:** Next.js 15 App Router monolith with PostgreSQL. Mastra v1.0 for AI agents with MCP tool integration. better-auth for sessions. grammY for Telegram webhook. SSE for real-time cross-channel sync. All secrets stored in DB, encrypted with auto-generated master key.

**Tech Stack:** Next.js 15, Tailwind CSS v4, shadcn/ui, Mastra v1.0, Vercel AI SDK, better-auth, grammY, Drizzle ORM, PostgreSQL, Geist font, Lucide icons

**Spec:** `docs/superpowers/specs/2026-03-20-phase0-personal-ai-chat-design.md`

**Design system:** Strict minimal (Vercel Geist inspired). oklch colors, text-sm default, shadow-sm max, 8px radius base, Lucide icons only. Full design system rules in user-provided document.

---

## Parallelization Map

```
Task 1 (scaffold) ─────────────────────────────┐
                                                 │
Task 2 (database) ──────────────────────────────┤
                                                 │
         ┌───────────────────────────────────────┤
         │                                       │
Task 3 (auth) ──┐    Task 5 (chat backend)      Task 4 (layout+theme)
                 │              │                        │
         Task 8 (wizard)  Task 6 (chat UI)      Task 7 (settings UI)
                               │                        │
                          Task 10 (SSE sync)            │
                               │                        │
                          Task 9 (telegram) ────────────┘
                               │
                          Task 11 (docker+PWA)
```

**Wave 1:** Task 1 (scaffold)
**Wave 2:** Task 2 (database)
**Wave 3 (parallel):** Tasks 3, 4, 5
**Wave 4 (parallel):** Tasks 6, 7, 8
**Wave 5 (parallel):** Tasks 9, 10
**Wave 6:** Task 11 (docker + PWA + integration)

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `next.config.ts`
- Create: `tsconfig.json`
- Create: `components.json`
- Create: `postcss.config.mjs`
- Create: `src/app/globals.css`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/lib/utils.ts`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Initialize Next.js project**

```bash
cd /Users/ly/dev/anticlaw
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --turbopack --no-git
```

- [ ] **Step 2: Initialize git repository**

```bash
cd /Users/ly/dev/anticlaw
git init
```

- [ ] **Step 3: Install core dependencies**

```bash
npm install geist next-themes sonner motion react-markdown remark-gfm shiki nanoid zod
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

- [ ] **Step 4: Install AI dependencies**

```bash
npm install @mastra/core @mastra/memory @mastra/pg @mastra/mcp @mastra/ai-sdk
npm install ai @ai-sdk/react @ai-sdk/openai @ai-sdk/anthropic @openrouter/ai-sdk-provider ollama-ai-provider-v2
```

- [ ] **Step 5: Install auth + telegram dependencies**

```bash
npm install better-auth grammy
```

- [ ] **Step 6: Initialize shadcn/ui**

```bash
npx shadcn@latest init -d
```

Then install needed components:

```bash
npx shadcn@latest add button input textarea label dialog sheet dropdown-menu select sidebar separator scroll-area avatar badge skeleton tooltip command card switch tabs toggle-group form alert collapsible sonner
```

- [ ] **Step 7: Write globals.css with oklch color system**

Replace `src/app/globals.css` with the full oklch design system from the spec (the complete CSS with light/dark themes, all CSS variables).

```css
@import "tailwindcss";

@theme inline {
  --font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, monospace;
  --radius: 0.5rem;
}

@layer base {
  :root {
    --background: oklch(0.995 0 0);
    --foreground: oklch(0.145 0.005 285);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.145 0.005 285);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.145 0.005 285);
    --primary: oklch(0.205 0.01 285);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.965 0.003 285);
    --secondary-foreground: oklch(0.205 0.01 285);
    --muted: oklch(0.965 0.003 285);
    --muted-foreground: oklch(0.556 0.01 285);
    --accent: oklch(0.965 0.003 285);
    --accent-foreground: oklch(0.205 0.01 285);
    --destructive: oklch(0.577 0.245 27.33);
    --destructive-foreground: oklch(0.985 0 0);
    --border: oklch(0.922 0.004 285);
    --input: oklch(0.922 0.004 285);
    --ring: oklch(0.708 0.01 285);
    --sidebar: oklch(0.985 0 0);
    --sidebar-foreground: oklch(0.145 0.005 285);
    --sidebar-border: oklch(0.922 0.004 285);
    --sidebar-accent: oklch(0.965 0.003 285);
    --sidebar-accent-foreground: oklch(0.205 0.01 285);
    --sidebar-ring: oklch(0.708 0.01 285);
    --chart-1: oklch(0.646 0.222 41.12);
    --chart-2: oklch(0.6 0.118 184.71);
    --chart-3: oklch(0.398 0.07 227.39);
    --chart-4: oklch(0.828 0.189 84.43);
    --chart-5: oklch(0.769 0.188 70.08);
  }

  .dark {
    --background: oklch(0.105 0.005 285);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.105 0.005 285);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.145 0.005 285);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.985 0 0);
    --primary-foreground: oklch(0.205 0.01 285);
    --secondary: oklch(0.195 0.01 285);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.195 0.01 285);
    --muted-foreground: oklch(0.708 0.01 285);
    --accent: oklch(0.195 0.01 285);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.577 0.245 27.33);
    --destructive-foreground: oklch(0.985 0 0);
    --border: oklch(1 0 0 / 0.1);
    --input: oklch(1 0 0 / 0.12);
    --ring: oklch(0.556 0.01 285);
    --sidebar: oklch(0.09 0.005 285);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 0.08);
    --sidebar-accent: oklch(0.195 0.01 285);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-ring: oklch(0.556 0.01 285);
    --chart-1: oklch(0.488 0.243 264.05);
    --chart-2: oklch(0.696 0.17 162.48);
    --chart-3: oklch(0.769 0.188 70.08);
    --chart-4: oklch(0.627 0.265 303.9);
    --chart-5: oklch(0.645 0.246 16.44);
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

- [ ] **Step 8: Write root layout with Geist fonts and ThemeProvider**

`src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "AntiClaw",
  description: "Personal AI Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0a0a0a" />
      </head>
      <body className="font-sans antialiased text-sm">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 9: Write placeholder root page**

`src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  // Will be replaced with setup/auth check in Task 3
  redirect("/chat");
}
```

- [ ] **Step 10: Create .gitignore and .env.example**

`.gitignore`:
```
node_modules/
.next/
data/
.env
.env.local
*.tsbuildinfo
```

`.env.example`:
```
# No .env required! All config is done through the web UI.
# Only set DATABASE_URL if NOT using docker-compose (which auto-configures it).
# DATABASE_URL=postgresql://anticlaw:anticlaw@localhost:5432/anticlaw
```

- [ ] **Step 11: Verify build**

```bash
npm run build
```

Expected: successful build with no errors.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: project scaffold — Next.js 15, Tailwind v4, shadcn/ui, Geist fonts, oklch design system"
```

---

## Task 2: Database + Settings + Crypto

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/lib/db/index.ts`
- Create: `src/lib/db/schema.ts`
- Create: `src/lib/crypto.ts`
- Create: `src/lib/settings.ts`
- Create: `docker-compose.yml` (postgres service only for now)

**Depends on:** Task 1

- [ ] **Step 1: Write docker-compose.yml with postgres**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: anticlaw
      POSTGRES_PASSWORD: anticlaw
      POSTGRES_DB: anticlaw
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U anticlaw"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres-data:
```

- [ ] **Step 2: Start postgres**

```bash
docker compose up -d postgres
```

Expected: postgres container running, healthy.

- [ ] **Step 3: Write drizzle config**

`drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://anticlaw:anticlaw@localhost:5432/anticlaw",
  },
});
```

- [ ] **Step 4: Write database schema**

`src/lib/db/schema.ts`:

```typescript
import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  index,
  bigint,
} from "drizzle-orm/pg-core";

// Platform settings (key-value, some encrypted)
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  isEncrypted: boolean("is_encrypted").default(false),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// better-auth managed tables
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
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
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

// LLM provider configurations
export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    apiKey: text("api_key"),
    baseUrl: text("base_url"),
    defaultModel: text("default_model"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_provider_configs_user_id").on(table.userId)]
);

// Chats
export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    model: text("model"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("idx_chats_user_id").on(table.userId)]
);

// Messages
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    platform: text("platform").default("web"),
    telegramMessageId: integer("telegram_message_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_messages_chat_id").on(table.chatId),
    index("idx_messages_created_at").on(table.createdAt),
  ]
);

// Telegram account linking
export const telegramLinks = pgTable(
  "telegram_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" })
      .notNull()
      .unique(),
    telegramUsername: text("telegram_username"),
    linkedAt: timestamp("linked_at").defaultNow(),
  },
  (table) => [
    index("idx_telegram_links_tg_user_id").on(table.telegramUserId),
  ]
);

// Link codes (ephemeral)
export const linkCodes = pgTable("link_codes", {
  code: text("code").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
});
```

- [ ] **Step 5: Write Drizzle instance**

`src/lib/db/index.ts`:

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://anticlaw:anticlaw@localhost:5432/anticlaw";

export const db = drizzle(connectionString, { schema });
```

- [ ] **Step 6: Write crypto utility**

`src/lib/crypto.ts`:

```typescript
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string, keyHex: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(":");
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}
```

- [ ] **Step 7: Write settings helpers**

`src/lib/settings.ts`:

```typescript
import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "./db/schema";
import { encrypt, decrypt, generateSecret } from "./crypto";

let masterKeyCache: string | null = null;

export async function getMasterKey(): Promise<string> {
  if (masterKeyCache) return masterKeyCache;

  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "auth_secret"))
    .limit(1);

  if (row[0]) {
    masterKeyCache = row[0].value;
    return masterKeyCache;
  }

  const secret = generateSecret();
  await db.insert(settings).values({
    key: "auth_secret",
    value: secret,
    isEncrypted: false,
  });
  masterKeyCache = secret;
  return secret;
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  if (!row[0]) return null;

  if (row[0].isEncrypted) {
    const masterKey = await getMasterKey();
    return decrypt(row[0].value, masterKey);
  }

  return row[0].value;
}

export async function setSetting(
  key: string,
  value: string,
  encrypted = false
): Promise<void> {
  const storedValue = encrypted
    ? encrypt(value, await getMasterKey())
    : value;

  await db
    .insert(settings)
    .values({ key, value: storedValue, isEncrypted: encrypted })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: storedValue, isEncrypted: encrypted, updatedAt: new Date() },
    });
}

export async function isSetupComplete(): Promise<boolean> {
  const val = await getSetting("setup_complete");
  return val === "true";
}
```

- [ ] **Step 8: Run migrations**

```bash
npx drizzle-kit push
```

Expected: all tables created in postgres.

- [ ] **Step 9: Write test for crypto**

`src/lib/__tests__/crypto.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { encrypt, decrypt, generateSecret } from "../crypto";

describe("crypto", () => {
  it("encrypts and decrypts correctly", () => {
    const key = generateSecret();
    const plaintext = "sk-proj-abc123456";
    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(":")).toHaveLength(3);
    expect(decrypt(encrypted, key)).toBe(plaintext);
  });

  it("fails with wrong key", () => {
    const key1 = generateSecret();
    const key2 = generateSecret();
    const encrypted = encrypt("secret", key1);
    expect(() => decrypt(encrypted, key2)).toThrow();
  });
});
```

- [ ] **Step 10: Install vitest and run test**

```bash
npm install -D vitest
npx vitest run src/lib/__tests__/crypto.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: database schema, crypto, settings — PostgreSQL + Drizzle + encrypted key-value store"
```

---

## Task 3: Auth System

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/lib/auth-client.ts`
- Create: `src/app/api/auth/[...all]/route.ts`
- Create: `src/app/(auth)/login/page.tsx`
- Modify: `src/app/page.tsx`
- Create: `src/middleware.ts`

**Depends on:** Task 2

- [ ] **Step 1: Write auth server config with lazy init**

`src/lib/auth.ts`:

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import { getMasterKey } from "./settings";

let _auth: ReturnType<typeof betterAuth> | null = null;

export async function getAuth() {
  if (_auth) return _auth;

  const secret = await getMasterKey();

  _auth = betterAuth({
    secret,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: {
      enabled: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    plugins: [nextCookies()],
  });

  return _auth;
}
```

- [ ] **Step 2: Write auth client**

`src/lib/auth-client.ts`:

```typescript
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
```

- [ ] **Step 3: Write auth API route**

`src/app/api/auth/[...all]/route.ts`:

```typescript
import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export async function GET(request: Request) {
  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.GET(request);
}

export async function POST(request: Request) {
  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.POST(request);
}
```

- [ ] **Step 4: Write middleware for setup check + auth**

The middleware needs to check BOTH setup completion and authentication. Since middleware runs on every request and we can't easily call the DB from edge middleware, we use a lightweight approach: check for a `setup_complete` cookie that gets set after setup, plus the session cookie.

`src/middleware.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/signup", "/setup", "/api/auth", "/api/webhook", "/api/setup"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/manifest.json" ||
    pathname === "/sw.js"
  ) {
    return NextResponse.next();
  }

  // Check setup status — the setup API sets this cookie when complete.
  // The root page.tsx also checks the DB as a fallback.
  const setupComplete = request.cookies.get("setup_complete");
  if (!setupComplete) {
    // Could be first visit or cookie cleared — redirect to root which checks DB
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Check auth
  const sessionToken = request.cookies.get("better-auth.session_token");
  if (!sessionToken) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

The setup API (`/api/setup`, step "complete") must also set the `setup_complete` cookie:

```typescript
// In /api/setup route.ts, after step === "complete":
const response = NextResponse.json({ success: true });
response.cookies.set("setup_complete", "true", {
  httpOnly: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 365, // 1 year
});
return response;
```

The root `page.tsx` does the definitive DB check and sets the cookie if needed:

```tsx
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isSetupComplete } from "@/lib/settings";

export default async function Home() {
  const setupDone = await isSetupComplete();
  if (!setupDone) redirect("/setup");

  // Ensure cookie is set for middleware
  const cookieStore = await cookies();
  if (!cookieStore.get("setup_complete")) {
    cookieStore.set("setup_complete", "true");
  }

  redirect("/chat");
}
```
```

- [ ] **Step 5: Write login page**

`src/app/(auth)/login/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const { error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: "/chat",
    });

    if (error) {
      toast.error(error.message || "Failed to sign in");
      setLoading(false);
      return;
    }

    router.push("/chat");
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">AntiClaw</h1>
          <p className="text-muted-foreground">Sign in to your account</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Update root page with setup/auth check**

`src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/settings";

export default async function Home() {
  const setupDone = await isSetupComplete();
  if (!setupDone) redirect("/setup");
  redirect("/chat");
}
```

- [ ] **Step 7: Verify auth flow compiles**

```bash
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: auth system — better-auth with lazy init, login page, middleware"
```

---

## Task 4: Dashboard Layout + Theme

**Files:**
- Create: `src/app/(dashboard)/layout.tsx`
- Create: `src/components/layout/app-sidebar.tsx`
- Create: `src/components/layout/header.tsx`
- Create: `src/components/layout/theme-switcher.tsx`

**Depends on:** Task 1

- [ ] **Step 1: Write dashboard layout with SidebarProvider**

`src/app/(dashboard)/layout.tsx`:

```tsx
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
```

- [ ] **Step 2: Write app sidebar**

`src/components/layout/app-sidebar.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { MessageSquare, Settings, Plus } from "lucide-react";
import { ThemeSwitcher } from "./theme-switcher";

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar>
      <SidebarHeader className="p-3">
        <span className="font-medium">AntiClaw</span>
        <Button variant="outline" size="sm" className="w-full mt-2" asChild>
          <Link href="/chat">
            <Plus className="h-4 w-4 mr-1.5" />
            New Chat
          </Link>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/chat"}>
                  <Link href="/chat">
                    <MessageSquare className="h-4 w-4" />
                    <span>All Chats</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-3 space-y-2">
        <ThemeSwitcher />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname.startsWith("/settings")}>
              <Link href="/settings">
                <Settings className="h-4 w-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
```

- [ ] **Step 3: Write theme switcher**

`src/components/layout/theme-switcher.tsx`:

```tsx
"use client";

import { useTheme } from "next-themes";
import { Monitor, Sun, Moon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <ToggleGroup
      type="single"
      value={theme}
      onValueChange={(v) => v && setTheme(v)}
      size="sm"
      className="justify-start"
    >
      <ToggleGroupItem value="system" className="h-7 w-7 p-0">
        <Monitor className="h-3.5 w-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem value="light" className="h-7 w-7 p-0">
        <Sun className="h-3.5 w-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" className="h-7 w-7 p-0">
        <Moon className="h-3.5 w-3.5" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
```

- [ ] **Step 4: Write page header**

`src/components/layout/header.tsx`:

```tsx
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

export function Header({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="h-4" />
      <h1 className="text-base font-medium flex-1">{title}</h1>
      {children}
    </header>
  );
}
```

- [ ] **Step 5: Create placeholder chat page**

`src/app/(dashboard)/chat/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { nanoid } from "nanoid";

export default function ChatListPage() {
  redirect(`/chat/${nanoid()}`);
}
```

- [ ] **Step 6: Verify layout renders**

```bash
npm run dev
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: dashboard layout — sidebar, header, theme switcher"
```

---

## Task 5: Chat Backend

**Files:**
- Create: `src/lib/providers/index.ts`
- Create: `src/lib/agents/index.ts`
- Create: `src/lib/agents/chat-agent.ts`
- Create: `src/lib/mcp/config.ts`
- Create: `src/app/api/chat/route.ts`

**Depends on:** Task 2

- [ ] **Step 1: Write provider factory**

`src/lib/providers/index.ts`:

```typescript
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ollama } from "ollama-ai-provider-v2";

export function getModel(
  provider: string,
  modelId: string,
  config?: { apiKey?: string; baseUrl?: string }
) {
  switch (provider) {
    case "openai":
      return openai(modelId, { apiKey: config?.apiKey });
    case "anthropic":
      return anthropic(modelId, { apiKey: config?.apiKey });
    case "openrouter":
      return createOpenRouter({ apiKey: config?.apiKey! }).chat(modelId);
    case "ollama":
      return ollama(modelId, { baseURL: config?.baseUrl });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"],
  openrouter: ["openai/gpt-4o", "anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro"],
  ollama: ["llama3.3", "qwen3", "mistral"],
};
```

- [ ] **Step 2: Write MCP config**

`src/lib/mcp/config.ts`:

```typescript
import { MCPClient } from "@mastra/mcp";

export function createMCPClient(userStoragePath: string) {
  return new MCPClient({
    id: "anticlaw-mcp",
    servers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", userStoragePath],
      },
    },
  });
}
```

- [ ] **Step 3: Write Mastra chat agent**

`src/lib/agents/chat-agent.ts`:

```typescript
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { PgStore } from "@mastra/pg";

const connectionString =
  process.env.DATABASE_URL || "postgresql://anticlaw:anticlaw@localhost:5432/anticlaw";

export const chatAgentMemory = new Memory({
  storage: new PgStore({ id: "anticlaw-memory", connectionString }),
  options: {
    lastMessages: 40,
    workingMemory: {
      enabled: true,
      template: "# User Context\n- Name:\n- Preferences:\n- Key facts:",
    },
  },
});

export function createChatAgent(
  model: Parameters<typeof Agent>[0]["model"],
  tools: Record<string, any>
) {
  return new Agent({
    id: "chat-agent",
    name: "AntiClaw Assistant",
    instructions: `You are a helpful personal AI assistant called AntiClaw.
You have access to tools for file management and other tasks.
Always confirm before executing actions with side effects.
Be concise and direct.`,
    model,
    tools,
    memory: chatAgentMemory,
  });
}
```

`src/lib/agents/index.ts`:

```typescript
import { Mastra } from "@mastra/core";

export const mastra = new Mastra({ agents: {} });
```

- [ ] **Step 4: Write chat API route**

`src/app/api/chat/route.ts`:

```typescript
import { createUIMessageStreamResponse } from "ai";
import { handleChatStream } from "@mastra/ai-sdk";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs, chats } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel } from "@/lib/providers";
import { createChatAgent } from "@/lib/agents/chat-agent";
import { createMCPClient } from "@/lib/mcp/config";
import { headers } from "next/headers";

export async function POST(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const userId = session.user.id;
  const body = await req.json();
  const { chatId: requestChatId, model: requestModel } = body;

  // Get or create chat
  let chatId = requestChatId;
  if (!chatId) {
    chatId = nanoid();
    await db.insert(chats).values({
      id: chatId,
      userId,
      title: "New Chat",
      model: requestModel,
    });
  }

  // Load provider config
  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (!config) return new Response("No LLM provider configured", { status: 400 });

  let apiKey = config.apiKey;
  if (apiKey) {
    const masterKey = await getMasterKey();
    apiKey = decrypt(apiKey, masterKey);
  }

  const modelId = requestModel || config.defaultModel || "gpt-4o";
  const model = getModel(config.provider, modelId, {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });

  const userStoragePath = `./data/storage/${userId}`;
  const mcpClient = createMCPClient(userStoragePath);
  const tools = await mcpClient.listTools();
  const agent = createChatAgent(model, tools);

  const stream = await handleChatStream({
    mastra: undefined as any,
    agent,
    params: {
      ...body,
      memory: { thread: chatId, resource: userId },
    },
  });

  return createUIMessageStreamResponse({ stream });
}
```

- [ ] **Step 5: Verify compilation**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: chat backend — Mastra agent, provider factory, MCP tools, streaming API"
```

---

## Task 6: Chat UI

**Files:**
- Create: `src/app/(dashboard)/chat/[id]/page.tsx`
- Create: `src/components/chat/chat-panel.tsx`
- Create: `src/components/chat/message.tsx`
- Create: `src/components/chat/chat-input.tsx`
- Create: `src/components/chat/model-selector.tsx`

**Depends on:** Task 4, Task 5

- [ ] **Step 1: Write message component**

`src/components/chat/message.tsx`:

```tsx
"use client";

import { cn } from "@/lib/utils";
import { Bot, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";

export function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-3 py-4", isUser && "flex-row-reverse")}>
      <Avatar className="h-7 w-7 shrink-0">
        <AvatarFallback className="text-xs">
          {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>
      <div className={cn("flex-1 leading-relaxed space-y-2", isUser && "text-right")}>
        <div className={cn("inline-block rounded-md px-3 py-2", isUser && "bg-muted")}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const isBlock = className?.includes("language-");
                if (isBlock) {
                  return (
                    <pre className="bg-muted rounded-md p-3 overflow-x-auto my-2">
                      <code className={cn("font-mono text-sm", className)} {...props}>
                        {children}
                      </code>
                    </pre>
                  );
                }
                return (
                  <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {typeof message.content === "string" ? message.content : JSON.stringify(message.content)}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write chat input**

`src/components/chat/chat-input.tsx`:

```tsx
"use client";

import { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, Square } from "lucide-react";

export function ChatInput({
  input, setInput, onSubmit, isLoading, onStop,
}: {
  input: string; setInput: (v: string) => void;
  onSubmit: () => void; isLoading: boolean; onStop: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) onSubmit();
    }
  }

  return (
    <div className="border-t p-4">
      <div className="flex items-end gap-2 max-w-3xl mx-auto">
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          className="min-h-[40px] max-h-[200px] resize-none"
          rows={1}
        />
        {isLoading ? (
          <Button variant="outline" size="icon" onClick={onStop} className="shrink-0">
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="icon" onClick={onSubmit} disabled={!input.trim()} className="shrink-0">
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write model selector**

`src/components/chat/model-selector.tsx`:

```tsx
"use client";

import {
  Select, SelectContent, SelectGroup, SelectItem,
  SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PROVIDER_MODELS } from "@/lib/providers";

export function ModelSelector({
  value, onValueChange, providers,
}: {
  value: string; onValueChange: (v: string) => void; providers: string[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent text-xs text-muted-foreground hover:text-foreground">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {providers.map((provider) => (
          <SelectGroup key={provider}>
            <SelectLabel className="text-xs capitalize">{provider}</SelectLabel>
            {(PROVIDER_MODELS[provider] || []).map((model) => (
              <SelectItem key={`${provider}/${model}`} value={`${provider}/${model}`} className="text-xs">
                {model}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 4: Write chat panel**

`src/components/chat/chat-panel.tsx`:

```tsx
"use client";

import { useChat } from "@ai-sdk/react";
import { useRef, useEffect } from "react";
import { ChatMessage } from "./message";
import { ChatInput } from "./chat-input";
import { ModelSelector } from "./model-selector";
import { Header } from "@/components/layout/header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageSquare } from "lucide-react";

export function ChatPanel({
  chatId, providers, defaultModel,
}: {
  chatId: string; providers: string[]; defaultModel: string;
}) {
  const { messages, input, setInput, handleSubmit, status, stop } = useChat({
    api: "/api/chat",
    body: { chatId },
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "streaming" || status === "submitted";

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex flex-col h-full">
      <Header title="Chat">
        <ModelSelector value={defaultModel} onValueChange={() => {}} providers={providers} />
      </Header>
      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-muted-foreground">
              <MessageSquare className="h-8 w-8" />
              <p>Start a conversation</p>
            </div>
          ) : (
            <div className="divide-y">
              {messages.map((m) => <ChatMessage key={m.id} message={m} />)}
            </div>
          )}
          <div ref={scrollRef} />
        </div>
      </ScrollArea>
      <ChatInput
        input={input} setInput={setInput}
        onSubmit={() => input.trim() && handleSubmit()}
        isLoading={isLoading} onStop={stop}
      />
    </div>
  );
}
```

- [ ] **Step 5: Write chat page**

`src/app/(dashboard)/chat/[id]/page.tsx`:

```tsx
import { ChatPanel } from "@/components/chat/chat-panel";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getAuth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const configs = await db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, session.user.id));

  const providers = configs.map((c) => c.provider);
  const defaultModel = configs[0]
    ? `${configs[0].provider}/${configs[0].defaultModel || "gpt-4o"}`
    : "openai/gpt-4o";

  return <ChatPanel chatId={id} providers={providers} defaultModel={defaultModel} />;
}
```

- [ ] **Step 6: Add command palette (Cmd+K)**

Create `src/components/layout/command-palette.tsx` using shadcn Command component:
- Search chats by title
- Quick actions: "New Chat", "Settings", "Connections"
- Trigger: `Cmd+K` (Mac) / `Ctrl+K` (Windows) via `useEffect` keydown listener
- Add `<CommandPalette />` to dashboard layout

Also add keyboard shortcuts: `Cmd+N` → new chat, `Cmd+B` → toggle sidebar (via `useSidebar()` from shadcn).

- [ ] **Step 7: Verify chat UI**

```bash
npm run dev
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: chat UI — message list, streaming, model selector, input with auto-resize"
```

---

## Task 7: Settings Pages

**Files:**
- Create: `src/app/(dashboard)/settings/page.tsx`
- Create: `src/app/(dashboard)/settings/layout.tsx`
- Create: `src/app/(dashboard)/settings/connections/page.tsx`
- Create: `src/app/(dashboard)/settings/integrations/page.tsx`
- Create: `src/app/api/settings/route.ts`
- Create: `src/app/api/settings/providers/route.ts`
- Create: `src/app/api/settings/providers/test/route.ts`

**Depends on:** Task 4, Task 2

- [ ] **Step 1: Write settings layout with vertical nav**

`src/app/(dashboard)/settings/layout.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Header } from "@/components/layout/header";
import { cn } from "@/lib/utils";
import { Settings, Link2, Puzzle } from "lucide-react";

const NAV = [
  { href: "/settings", label: "General", icon: Settings },
  { href: "/settings/connections", label: "Connections", icon: Link2 },
  { href: "/settings/integrations", label: "Integrations", icon: Puzzle },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col h-full">
      <Header title="Settings" />
      <div className="flex flex-1 overflow-hidden">
        <nav className="w-48 border-r p-3 space-y-1 shrink-0">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                pathname === item.href
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}>
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write general settings page**

`src/app/(dashboard)/settings/page.tsx`:

```tsx
"use client";

import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function GeneralSettingsPage() {
  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">General</h2>
        <p className="text-muted-foreground mt-1">Platform appearance and preferences.</p>
      </div>
      <Separator />
      <div className="space-y-1.5">
        <Label>Theme</Label>
        <ThemeSwitcher />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write provider API routes**

`src/app/api/settings/providers/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { encrypt } from "@/lib/crypto";
import { getMasterKey } from "@/lib/settings";
import { nanoid } from "nanoid";
import { headers } from "next/headers";

export async function GET() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const configs = await db
    .select({
      id: providerConfigs.id,
      provider: providerConfigs.provider,
      defaultModel: providerConfigs.defaultModel,
      baseUrl: providerConfigs.baseUrl,
      isActive: providerConfigs.isActive,
    })
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, session.user.id));

  return NextResponse.json(configs);
}

export async function POST(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { provider, apiKey, defaultModel, baseUrl } = await req.json();
  const masterKey = await getMasterKey();

  const id = nanoid();
  await db.insert(providerConfigs).values({
    id,
    userId: session.user.id,
    provider,
    apiKey: apiKey ? encrypt(apiKey, masterKey) : null,
    defaultModel,
    baseUrl: baseUrl || null,
  });

  return NextResponse.json({ id });
}

export async function DELETE(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { id } = await req.json();
  await db.delete(providerConfigs).where(
    and(eq(providerConfigs.id, id), eq(providerConfigs.userId, session.user.id))
  );

  return NextResponse.json({ ok: true });
}
```

`src/app/api/settings/providers/test/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getModel } from "@/lib/providers";
import { generateText } from "ai";

export async function POST(req: Request) {
  const { provider, apiKey, modelId, baseUrl } = await req.json();

  try {
    const model = getModel(provider, modelId || "gpt-4o-mini", { apiKey, baseUrl });
    const result = await generateText({
      model,
      prompt: "Say 'ok' and nothing else.",
      maxTokens: 5,
    });
    return NextResponse.json({ success: true, response: result.text });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }
}
```

`src/app/api/settings/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { headers } from "next/headers";

export async function GET(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  const value = await getSetting(key);
  return NextResponse.json({ value });
}

export async function PUT(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { key, value, encrypted } = await req.json();
  await setSetting(key, value, encrypted);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Write connections page**

`src/app/(dashboard)/settings/connections/page.tsx` — Provider management UI:
- `useEffect` fetches `GET /api/settings/providers` on mount
- Lists providers as cards: provider name + model badge + delete button
- "Add Provider" button toggles a form: provider select, API key (password input), default model, base URL (for ollama)
- "Test & Save" button calls `POST /api/settings/providers/test` then `POST /api/settings/providers`
- Delete calls `DELETE /api/settings/providers` with provider id
- Toast notifications via sonner for success/error

- [ ] **Step 5: Write integrations page (placeholder for now)**

`src/app/(dashboard)/settings/integrations/page.tsx` — Placeholder with "Telegram integration will be configured here."

- [ ] **Step 6: Verify settings pages**

```bash
npm run dev
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: settings — general, connections (provider CRUD + test), integrations placeholder"
```

---

## Task 8: Setup Wizard

**Files:**
- Create: `src/app/(setup)/layout.tsx`
- Create: `src/app/(setup)/setup/page.tsx`
- Create: `src/components/setup/setup-wizard.tsx`
- Create: `src/app/api/setup/route.ts`

**Depends on:** Task 3, Task 7

- [ ] **Step 1: Write setup layout (no sidebar, centered)**

`src/app/(setup)/layout.tsx`:

```tsx
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md px-4">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Write setup API route**

`src/app/api/setup/route.ts` — Handles 3 steps:
- `step: "account"` — saves admin email to settings
- `step: "provider"` — encrypts and saves provider config
- `step: "complete"` — sets `setup_complete = true`

Blocks re-running if setup already complete.

- [ ] **Step 3: Write setup wizard component**

`src/components/setup/setup-wizard.tsx` — 3-step form:
1. Account: name + email + password → `authClient.signUp.email()`
2. Provider: select + API key + model → test connection → save
3. Telegram: bot token (optional, skippable) → save → mark complete → redirect to /chat

Progress indicator: 3 dots at top showing current step.

- [ ] **Step 4: Write setup page**

`src/app/(setup)/setup/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/settings";
import { SetupWizard } from "@/components/setup/setup-wizard";

export default async function SetupPage() {
  if (await isSetupComplete()) redirect("/chat");
  return <SetupWizard />;
}
```

- [ ] **Step 5: Test setup flow end-to-end**

Reset database, visit `/` → should redirect to `/setup` → complete 3 steps → end up at `/chat`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: setup wizard — 3-step onboarding (account, provider, telegram)"
```

---

## Task 9: Telegram Integration

**Files:**
- Create: `src/lib/telegram/bot.ts`
- Create: `src/lib/telegram/agent-handler.ts`
- Create: `src/app/api/webhook/telegram/route.ts`
- Create: `src/app/api/settings/telegram/link/route.ts`
- Modify: `src/app/(dashboard)/settings/integrations/page.tsx`

**Depends on:** Task 5, Task 7

- [ ] **Step 1: Write grammY bot**

`src/lib/telegram/bot.ts`:

```typescript
import { Bot, webhookCallback } from "grammy";
import { nanoid } from "nanoid";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { telegramLinks, linkCodes, chats, messages } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { eventBus } from "@/lib/events";

let _bot: Bot | null = null;

export async function getBot(): Promise<Bot | null> {
  if (_bot) return _bot;
  const token = await getSetting("telegram_bot_token");
  if (!token) return null;

  _bot = new Bot(token);

  _bot.command("start", async (ctx) => {
    await ctx.reply("Welcome to AntiClaw! Use /link CODE to connect your account.");
  });

  _bot.command("link", async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply("Usage: /link CODE\nGet the code from Settings > Integrations.");
      return;
    }

    const [lc] = await db.select().from(linkCodes).where(eq(linkCodes.code, code)).limit(1);

    if (!lc || lc.expiresAt < new Date()) {
      if (lc) await db.delete(linkCodes).where(eq(linkCodes.code, code));
      await ctx.reply("Invalid or expired code. Generate a new one from Settings.");
      return;
    }

    await db.insert(telegramLinks).values({
      id: nanoid(),
      userId: lc.userId,
      telegramUserId: ctx.from!.id,
      telegramUsername: ctx.from?.username || null,
    });
    await db.delete(linkCodes).where(eq(linkCodes.code, code));
    await ctx.reply("Account linked! You can now chat here.");
  });

  _bot.command("new", async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) { await ctx.reply("Link your account first with /link CODE"); return; }

    await db.insert(chats).values({ id: nanoid(), userId: link.userId, title: "Telegram Chat" });
    await ctx.reply("New chat started!");
  });

  _bot.on("message:text", async (ctx) => {
    const link = await findLink(ctx.from!.id);
    if (!link) {
      await ctx.reply("Account not linked. Use /link CODE from Settings > Integrations.");
      return;
    }

    // Find most recent chat or create one
    let [chat] = await db.select().from(chats)
      .where(eq(chats.userId, link.userId))
      .orderBy(desc(chats.updatedAt)).limit(1);

    if (!chat) {
      const id = nanoid();
      await db.insert(chats).values({ id, userId: link.userId, title: ctx.message.text.slice(0, 100) });
      [chat] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
    }

    // Save user message
    await db.insert(messages).values({
      id: nanoid(), chatId: chat.id, role: "user",
      content: ctx.message.text, platform: "telegram",
      telegramMessageId: ctx.message.message_id,
    });
    await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chat.id));

    // Notify web clients
    eventBus.emit(`user:${link.userId}`, { type: "new_message", chatId: chat.id });

    try {
      const { processMessageForTelegram } = await import("./agent-handler");
      const response = await processMessageForTelegram(link.userId, chat.id, ctx.message.text);

      await db.insert(messages).values({
        id: nanoid(), chatId: chat.id, role: "assistant",
        content: response, platform: "telegram",
      });

      eventBus.emit(`user:${link.userId}`, { type: "new_message", chatId: chat.id });
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch (error: any) {
      await ctx.reply(`Error: ${error.message}`);
    }
  });

  return _bot;
}

async function findLink(telegramUserId: number) {
  const [link] = await db.select().from(telegramLinks)
    .where(eq(telegramLinks.telegramUserId, telegramUserId)).limit(1);
  return link || null;
}

export async function getWebhookHandler() {
  const bot = await getBot();
  if (!bot) return null;
  return webhookCallback(bot, "std/http");
}
```

- [ ] **Step 2: Write agent handler for Telegram**

`src/lib/telegram/agent-handler.ts`:

```typescript
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs, messages } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getModel } from "@/lib/providers";
import { createChatAgent } from "@/lib/agents/chat-agent";
import { createMCPClient } from "@/lib/mcp/config";

export async function processMessageForTelegram(
  userId: string, chatId: string, userMessage: string
): Promise<string> {
  const [config] = await db.select().from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (!config) throw new Error("No LLM provider configured");

  let apiKey = config.apiKey;
  if (apiKey) {
    const masterKey = await getMasterKey();
    apiKey = decrypt(apiKey, masterKey);
  }

  const model = getModel(config.provider, config.defaultModel || "gpt-4o", {
    apiKey: apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
  });

  const mcpClient = createMCPClient(`./data/storage/${userId}`);
  const tools = await mcpClient.listTools();
  const agent = createChatAgent(model, tools);

  const response = await agent.generate(userMessage, {
    memory: { thread: chatId, resource: userId },
  });

  await mcpClient.disconnect();
  return response.text;
}
```

- [ ] **Step 3: Write webhook route**

`src/app/api/webhook/telegram/route.ts`:

```typescript
import { getWebhookHandler } from "@/lib/telegram/bot";

export async function POST(req: Request) {
  const handler = await getWebhookHandler();
  if (!handler) return new Response("Bot not configured", { status: 503 });
  try {
    return await handler(req);
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return new Response("OK", { status: 200 });
  }
}
```

- [ ] **Step 4: Write link code API**

`src/app/api/settings/telegram/link/route.ts` — POST: generates 6-digit code (5min expiry), GET: checks link status.

- [ ] **Step 5: Update integrations page**

Full Telegram section: bot token input, save + register webhook, link account button (shows code), link status.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: telegram — grammY webhook, account linking, bidirectional message sync"
```

---

## Task 10: SSE Real-time Sync

**Files:**
- Create: `src/lib/events.ts`
- Create: `src/app/api/events/route.ts`
- Modify: `src/lib/telegram/bot.ts` (emit events)
- Modify: `src/components/chat/chat-panel.tsx` (listen to SSE)

**Depends on:** Task 5, Task 6

- [ ] **Step 1: Write event bus**

`src/lib/events.ts`:

```typescript
type Listener = (data: any) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(channel: string, listener: Listener): () => void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(listener);
    return () => { this.listeners.get(channel)?.delete(listener); };
  }

  emit(channel: string, data: any) {
    this.listeners.get(channel)?.forEach((fn) => fn(data));
  }
}

export const eventBus = new EventBus();
```

- [ ] **Step 2: Write SSE endpoint**

`src/app/api/events/route.ts` — Authenticated SSE stream per user. Subscribes to `user:{userId}` channel. 30s heartbeat. Pushes `{ type: "new_message", chatId }` events.

- [ ] **Step 3: Emit events from Telegram handler**

After saving Telegram messages, call `eventBus.emit(user:${userId}, { type: "new_message", chatId })`.

- [ ] **Step 4: Listen in chat panel**

Add `useEffect` with `EventSource("/api/events")` — on `new_message` event matching current chatId, trigger message refresh.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: SSE real-time sync — event bus, cross-channel message notifications"
```

---

## Task 11: Docker + PWA + Polish

**Files:**
- Create: `Dockerfile`
- Modify: `docker-compose.yml`
- Create: `public/manifest.json`
- Create: `public/sw.js`
- Create: `src/components/sw-register.tsx`
- Modify: `next.config.ts`
- Create: `data/.gitkeep`

**Depends on:** All previous tasks

- [ ] **Step 1: Write Dockerfile (multi-stage)**

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
RUN mkdir -p data/storage && chown -R nextjs:nodejs data
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
```

- [ ] **Step 2: Update next.config.ts**

```typescript
import type { NextConfig } from "next";
const nextConfig: NextConfig = { output: "standalone" };
export default nextConfig;
```

- [ ] **Step 3: Update docker-compose.yml**

Add `platform` service with `DATABASE_URL=postgresql://anticlaw:anticlaw@postgres:5432/anticlaw`, depends on healthy postgres.

- [ ] **Step 4: Write PWA manifest + service worker**

`public/manifest.json` — name, icons, display: standalone, theme_color.
`public/sw.js` — network-first fetch strategy.

- [ ] **Step 5: Write SW registration component**

`src/components/sw-register.tsx`:

```tsx
"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js");
    }
  }, []);
  return null;
}
```

Add `<ServiceWorkerRegister />` to root layout.

- [ ] **Step 6: Build and test Docker**

```bash
docker compose build platform
docker compose up
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Docker + PWA — multi-stage build, docker-compose, manifest, service worker"
```

---

## Integration Checklist

After all tasks complete, verify end-to-end:

- [ ] Fresh `docker compose up` → setup wizard appears
- [ ] Create admin account → add API key → test passes
- [ ] Skip Telegram → redirects to chat
- [ ] Send message → AI responds with streaming
- [ ] Dark/light/system theme works
- [ ] Settings > Connections: add/remove providers
- [ ] Settings > Integrations: add Telegram token → link account
- [ ] Telegram message → appears in web UI (via SSE)
- [ ] Mobile responsive: sidebar as sheet
- [ ] PWA installable
