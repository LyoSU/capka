import { SYSTEM_PROMPT, SANDBOX_PROMPT } from "@/lib/agents/chat-agent";
import { isNativeMultimodal, type FileRef } from "@/lib/constants";
import { formatAvailableSkills } from "@/lib/skills/fmt";

/**
 * The system prompt split into a cache-stable prefix and a volatile suffix.
 *
 * `stable` (base persona + sandbox + project instructions + available skills)
 * changes rarely, so it carries the prompt-cache breakpoint. `volatile`
 * (memories, workspace snapshot, just-attached files) changes per run and is
 * sent AFTER the breakpoint so it never invalidates the cached prefix. The
 * caller renders them as two consecutive system messages — see runner.ts.
 */
export interface BuiltPrompt {
  stable: string;
  volatile: string;
}

export function buildSystemPrompt(opts: {
  project?: { systemPrompt?: string | null } | null;
  memories: { content: string }[];
  skills?: { name: string; description: string | null }[];
  workspaceSnapshot?: string;
  attachedFiles?: FileRef[];
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
    const native = isNativeMultimodal(f.type);
    if (!native) hasToolOnly = true;
    promptLines.push(`  - /workspace/${f.name}${native ? " (attached natively — you can see/read it directly)" : ""}`);
  }
  if (promptLines.length > 0) {
    volatile += `${volatile ? "\n\n" : ""}## User just attached these files:\n${promptLines.join("\n")}`;
    if (hasToolOnly) volatile += `\nOpen non-native files with tools as needed.`;
  }

  return { stable, volatile };
}

/** Classify attached files into native multimodal vs tool-only */
export function classifyFiles(files?: FileRef[]): { nativeFiles: FileRef[]; hasToolOnly: boolean } {
  const nativeFiles: FileRef[] = [];
  let hasToolOnly = false;
  for (const f of files ?? []) {
    if (isNativeMultimodal(f.type)) nativeFiles.push(f);
    else hasToolOnly = true;
  }
  return { nativeFiles, hasToolOnly };
}
