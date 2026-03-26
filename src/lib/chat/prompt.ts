import { SYSTEM_PROMPT, SANDBOX_PROMPT } from "@/lib/agents/chat-agent";
import { isNativeMultimodal, type FileRef } from "@/lib/constants";

export function buildSystemPrompt(opts: {
  project?: { systemPrompt?: string | null } | null;
  memories: { content: string }[];
  workspaceSnapshot?: string;
  attachedFiles?: FileRef[];
}): string {
  let systemPrompt = `${SYSTEM_PROMPT}\n\n${SANDBOX_PROMPT}`;
  if (opts.project?.systemPrompt) {
    systemPrompt += `\n\n--- Project Instructions ---\n${opts.project.systemPrompt}`;
  }
  if (opts.memories.length > 0) {
    const memoryLines = opts.memories.map((m) => `- ${m.content}`).join("\n");
    systemPrompt += `\n\n## Things you know about the user:\n${memoryLines}`;
  }

  // Inject workspace snapshot so AI knows what files exist without extra ls calls
  if (opts.workspaceSnapshot) {
    systemPrompt += `\n\n## Current workspace files:\n\`\`\`\n${opts.workspaceSnapshot}\n\`\`\``;
  }

  // Single-pass: classify files and build prompt lines
  const fileList = opts.attachedFiles;
  const promptLines: string[] = [];
  let hasToolOnly = false;

  for (const f of fileList ?? []) {
    const native = isNativeMultimodal(f.type);
    if (!native) hasToolOnly = true;
    promptLines.push(`  - /workspace/${f.name}${native ? " (attached natively — you can see/read it directly)" : ""}`);
  }

  if (promptLines.length > 0) {
    systemPrompt += `\n\n## User just attached these files:\n${promptLines.join("\n")}`;
    if (hasToolOnly) systemPrompt += `\nOpen non-native files with tools as needed.`;
  }

  return systemPrompt;
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
