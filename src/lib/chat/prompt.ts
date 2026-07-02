import { SYSTEM_PROMPT, SANDBOX_PROMPT } from "@/lib/agents/chat-agent";
import { type FileRef } from "@/lib/constants";
import { acceptsNativeFile, mimeToModality, type Modality } from "@/lib/providers/registry";
import { formatAvailableSkills } from "@/lib/skills/fmt";

/**
 * The system prompt split into THREE cache tiers, rendered as consecutive
 * system messages (see runner.ts):
 *
 * 1. `stable`  — base persona + sandbox + project instructions + skills.
 *    Identical across every user and chat, so it carries the first cache
 *    breakpoint and is reused by everyone (highest hit rate).
 * 2. `session` — who the user is + when THIS conversation started. Constant
 *    for the whole conversation, so it carries its own breakpoint and is reused
 *    on every turn of that chat. CACHE-CRITICAL: it must be derived from the
 *    conversation start time, never a live clock — a per-turn value here would
 *    change the prefix and bust the cache for everything after it.
 * 3. `volatile` — memories, workspace snapshot, just-attached files. Changes
 *    per run, sent uncached after the breakpoints so churn never invalidates
 *    the cached prefixes.
 */
export interface BuiltPrompt {
  stable: string;
  session: string;
  volatile: string;
}

/** Makes the agent AWARE of the `manage` control plane so it uses it proactively
 *  when a user asks to change something, rather than saying "open settings".
 *  Role is enforced server-side inside the tool, so this stays role-neutral and
 *  cache-stable — a non-admin's attempt at an org setting simply fails. */
const MANAGE_PROMPT = `## Managing settings & configuration
When the user asks to change a preference or setting (their language/timezone, or — for admins — platform-wide configuration), do it yourself with the \`manage\` tool instead of pointing them at a settings page. Use \`list\`/\`capabilities\` to discover what THIS user may change; never invent a control id.

Permission is decided ENTIRELY by the server, from the result of an action you actually call — never by you reading a label. To do what the user asks, CALL the matching action (set/add/enable/…) and react to what comes back. Everything \`list\`/\`capabilities\` returns is ALREADY available to THIS user. So:
- NEVER refuse up front, never say "I'm only a regular user" or "ask your admin", and never mention a control's role/scope — just call the action.
- NEVER decide what YOU may do by reading a setting's value. Toggles like "members can install connectors" govern OTHER end-users; they do not restrict you-as-caller, and the server already applies your own role. So never cite such a setting as a reason you "can't" do something. Each collection in a list/get result carries a resolved \`canAdd\` boolean — that, and ONLY that, tells you whether you may add there; trust it over any inference.
- If you're only missing INFORMATION to act (e.g. a connector's URL or command), ask the user for exactly that, in one plain question — do NOT turn a missing URL into a story about permissions, admins, or disabled settings. To add a remote connector you need its \`url\`; for a local one, its \`command\`.
- Adding a personal connector (name+url) or a personal skill needs no admin at all.
- A \`confirm_required\` result means the change is STAGED and the user is ALREADY authorized (the server checked). A confirmation card/button is shown to them, and ONLY their click applies it — you CANNOT apply it yourself and there is no token to re-send. Do NOT claim you lack rights, do NOT re-explain, do NOT re-ask in prose, do NOT call the action again. Reply with at most one short line (e.g. "Ready — tap Confirm", in the user's language) or nothing, then STOP and wait — the applied change arrives on its own. Undo is a button too, not something you trigger.
- Only an \`error\` result with code \`forbidden\`/\`not_found\`/\`apply_failed\` means it truly can't happen — explain THAT result plainly. Never quote internal keys (like \`org.*\`) to the user; describe the setting in plain words.
- When the user describes a RECURRING intent ("щотижня", "щоранку", "стеж за", "нагадуй", "every Monday"), offer to create an automation (\`add\` on \`automations\`): the platform will run the instruction on schedule and deliver results as a new chat (+ Telegram if linked). Translate the schedule into a cron expression in the user's timezone yourself — the user must never see cron syntax; the approval card shows them the next run dates instead. For "remind me once at X" use \`once_at\`. After creating one, offer to run the instruction right now yourself as a test.`;

/**
 * Per-conversation context block (tier 2). Fixed for the whole conversation.
 *
 * Returning "" is safe — the caller then skips the breakpoint and the extra
 * system message entirely.
 *
 * CACHE RULE: only feed values that are constant across the conversation.
 * `startedAt` is the chat's creation time, NOT `new Date()` — see BuiltPrompt.
 */
export function buildSessionContext(opts: {
  user?: { name?: string | null; timezone?: string | null } | null;
  startedAt?: Date | null;
  locale?: string | null;
}): string {
  const name = opts.user?.name?.trim();
  const startedAt = opts.startedAt ?? null;
  // Nothing worth a whole cached system message → let the caller skip it.
  if (!name && !startedAt) return "";

  const tz = opts.user?.timezone || "UTC";
  const locale = opts.locale || "en";

  const lines: string[] = [];
  if (name) lines.push(`- Name: ${name}`);
  if (startedAt) {
    // Friendly local date+time. dateStyle/timeStyle can't carry a tz label, so
    // we append the IANA id — unambiguous and stable. A stored-but-invalid tz
    // would make Intl throw, so fall back to UTC rather than crash a run.
    let when: string;
    try {
      when = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(startedAt);
    } catch {
      when = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }).format(startedAt);
    }
    lines.push(`- This conversation started on ${when} (${tz}). Treat that as the current date/time unless the user indicates otherwise.`);
  }
  return `## Who you're talking to\n${lines.join("\n")}`;
}

export function buildSystemPrompt(opts: {
  project?: { systemPrompt?: string | null } | null;
  /** Self-maintaining memory docs (≈ ~/CLAUDE.md + project/CLAUDE.md), injected
   *  verbatim. Empty strings are skipped. */
  memoryDocs?: { user?: string; project?: string };
  skills?: { name: string; description: string | null; body?: string | null }[];
  workspaceSnapshot?: string;
  attachedFiles?: FileRef[];
  /** Resolved provider — gates which attachments are presented as native. */
  provider?: string;
  /** Resolved model's native input modalities (OpenRouter catalog), if known —
   *  takes precedence over the provider's static caps when gating attachments. */
  modelInput?: Modality[] | null;
  user?: { name?: string | null; timezone?: string | null } | null;
  conversationStartedAt?: Date | null;
  locale?: string | null;
  /** The operator's very first message right after finishing setup — adds a
   *  one-time concierge nudge so the agent welcomes them and offers to configure
   *  the optional bits (language, Telegram, a first connector) via `manage`. */
  concierge?: boolean;
}): BuiltPrompt {
  // ── Stable prefix (cacheable) ───────────────────────────────────────────
  let stable = `${SYSTEM_PROMPT}\n\n${SANDBOX_PROMPT}`;
  if (opts.project?.systemPrompt) {
    stable += `\n\n--- Project Instructions ---\n${opts.project.systemPrompt}`;
  }
  // Skills are deterministic (sorted, no timestamps) and change only on
  // install/toggle, so they belong in the cached prefix, not the volatile tail.
  const skillsBlock = formatAvailableSkills(opts.skills ?? []);
  if (skillsBlock) {
    stable += `\n\n${skillsBlock}`;
  }
  stable += `\n\n${MANAGE_PROMPT}`;

  // ── Session tier (cacheable, conversation-stable) ───────────────────────
  const session = buildSessionContext({
    user: opts.user,
    startedAt: opts.conversationStartedAt,
    locale: opts.locale,
  });

  // ── Volatile suffix (not cached) ────────────────────────────────────────
  let volatile = "";
  const userDoc = opts.memoryDocs?.user?.trim();
  const projectDoc = opts.memoryDocs?.project?.trim();
  if (userDoc) {
    volatile += `## What you remember about the user:\n${userDoc}`;
  }
  if (projectDoc) {
    volatile += `${volatile ? "\n\n" : ""}## What you remember about this project:\n${projectDoc}`;
  }

  // Workspace snapshot changes every run — must stay out of the cached prefix.
  if (opts.workspaceSnapshot) {
    volatile += `${volatile ? "\n\n" : ""}## Current workspace files:\n\`\`\`\n${opts.workspaceSnapshot}\n\`\`\``;
  }

  // Single-pass: classify files and build prompt lines
  const promptLines: string[] = [];
  let hasToolOnly = false;
  for (const f of opts.attachedFiles ?? []) {
    const native = acceptsNativeFile(f.type, opts.provider ?? "", opts.modelInput);
    if (!native) hasToolOnly = true;
    promptLines.push(`  - /workspace/${f.name}${native ? " (attached natively — you can see/read it directly)" : ""}`);
  }
  if (promptLines.length > 0) {
    volatile += `${volatile ? "\n\n" : ""}## User just attached these files:\n${promptLines.join("\n")}`;
    if (hasToolOnly) volatile += `\nOpen non-native files with tools as needed.`;
  }

  // One-time, first-message-after-setup concierge. In the volatile tier (never
  // cached) since it fires exactly once. English — the model relays in the user's
  // language, like the rest of the prompt.
  if (opts.concierge) {
    volatile += `${volatile ? "\n\n" : ""}## First run
This is the operator's FIRST message right after finishing setup. Warmly welcome them in one or two sentences, then offer to help set up the optional things you can do via the \`manage\` tool: their interface language, Telegram delivery, and adding a first connector or skill. Keep it brief — don't dump a list or a wall of options. If they already asked a real question, answer it first and add the offer at the end.`;
  }

  return { stable, session, volatile };
}

/**
 * Classify attached files into native multimodal vs tool-only, gated by what
 * the resolved model/provider actually accepts inline (see `acceptsNativeFile`).
 * Per-model modalities win when known; otherwise the provider's static caps
 * apply. An unknown/empty provider falls back to the safe side — images stay
 * native, everything else degrades to tool-only — so a missing provider never
 * reintroduces the `content[].type` rejection.
 */
export function classifyFiles(
  files?: FileRef[],
  provider?: string,
  modelInput?: Modality[] | null,
): { nativeFiles: FileRef[]; hasToolOnly: boolean } {
  const nativeFiles: FileRef[] = [];
  let hasToolOnly = false;
  for (const f of files ?? []) {
    if (acceptsNativeFile(f.type, provider ?? "", modelInput)) nativeFiles.push(f);
    else hasToolOnly = true;
  }
  return { nativeFiles, hasToolOnly };
}

/**
 * The distinct media modalities present in the attachments that the resolved
 * model CANNOT take natively — i.e. files the model is "blind/deaf" to. Only
 * real media modalities (image/pdf/audio/video) count; a plain document has no
 * modality and is correctly handled by sandbox tools, so it never warns. Drives
 * the capability notice that tells the user to switch to a capable model instead
 * of the model silently pretending it processed the file. First-seen order,
 * deduped.
 */
export function findBlindModalities(
  files?: FileRef[],
  provider?: string,
  modelInput?: Modality[] | null,
): Modality[] {
  const blind: Modality[] = [];
  for (const f of files ?? []) {
    const mod = mimeToModality(f.type);
    if (!mod) continue;
    if (acceptsNativeFile(f.type, provider ?? "", modelInput)) continue;
    if (!blind.includes(mod)) blind.push(mod);
  }
  return blind;
}
