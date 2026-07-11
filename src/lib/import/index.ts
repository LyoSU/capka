import { renderSharedChat, ImportError } from "./render";
import { parseSharedChat, normalizeImport } from "./parse";
import type { DetectedShareLink, SharedChatImport } from "./types";

export { detectShareLink, sourceLabel } from "./detect";
export { ImportError } from "./render";
export { normalizeImport } from "./parse";
export { MAX_IMPORT_MESSAGES, MAX_IMPORT_MESSAGE_CHARS, MAX_IMPORT_TOTAL_CHARS } from "./types";
export type { SharedChatImport, ImportedMessage, ImportSource, ImportErrorCode, DetectedShareLink } from "./types";

/**
 * The full preview pipeline: render the shared conversation in the sandbox, parse
 * the raw payload, and cap/sanitize it. Throws `ImportError("EMPTY")` when nothing
 * importable came back (e.g. an image-only conversation) so the caller shows a
 * clear "nothing to import" instead of creating a blank chat.
 */
export async function previewSharedChat(link: DetectedShareLink, userId: string): Promise<SharedChatImport> {
  const { raw } = await renderSharedChat(link, userId);
  const parsed = normalizeImport(parseSharedChat(link.source, raw));
  if (parsed.messages.length === 0) throw new ImportError("EMPTY");
  return parsed;
}
