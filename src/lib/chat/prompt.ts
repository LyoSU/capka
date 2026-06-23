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
  memories: { content: string }[];
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

  // ── Session tier (cacheable, conversation-stable) ───────────────────────
  const session = buildSessionContext({
    user: opts.user,
    startedAt: opts.conversationStartedAt,
    locale: opts.locale,
  });

  // ── Volatile suffix (not cached) ────────────────────────────────────────
  let volatile = "";
  if (opts.memories.length > 0) {
    const memoryLines = opts.memories.map((m) => `- ${m.content}`).join("\n");
    volatile += `## Things you know about the user:\n${memoryLines}`;
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
