import type { FileRef } from "@/lib/constants";

/** Files and text handed to Capka from outside the composer — the OS share sheet
 *  (manifest `share_target`, landing at /intake) or "Open with" (manifest
 *  `file_handlers`, delivered through `launchQueue`). Either way it ends up in a
 *  fresh chat's composer, staged and NOT sent: the person still says what to do. */
export type Intake = { refs?: FileRef[]; files?: File[]; text?: string };

/** The share sheet's title/text/url as one composer draft. Android puts the link
 *  in `text` more often than in `url`, so a url already inside the text is not
 *  repeated; a title that is just the url (or the text) is dropped too. */
export function shareText({ title, text, url }: { title?: string | null; text?: string | null; url?: string | null }): string {
  const parts: string[] = [];
  const add = (s?: string | null) => {
    const v = s?.trim();
    if (v && !parts.some((p) => p.includes(v))) parts.push(v);
  };
  add(text);
  add(url);
  if (title?.trim() && !parts.some((p) => p.includes(title.trim()))) parts.unshift(title.trim());
  return parts.join("\n");
}

/** The /intake route has uploaded the files server-side and can only hand the
 *  result over in its redirect, so it rides in the URL fragment: never sent back
 *  to the server, never in an access log, and gone from the address bar as soon
 *  as the chat reads it. */
export function intakeHash(refs: FileRef[], text: string): string {
  return `#intake=${encodeURIComponent(JSON.stringify({ refs, text }))}`;
}

export function parseIntakeHash(hash: string): Intake | null {
  const m = /^#intake=(.*)$/.exec(hash);
  if (!m) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(m[1])) as { refs?: unknown; text?: unknown };
    const refs = (Array.isArray(raw.refs) ? raw.refs : [])
      .filter((r): r is FileRef => !!r && typeof r.name === "string" && r.name.length > 0 && typeof r.type === "string")
      .map(({ name, type }) => ({ name, type }));
    return { refs, text: typeof raw.text === "string" ? raw.text : "" };
  } catch {
    return null;
  }
}

// "Open with" files arrive in-page (launchQueue) possibly before the chat panel
// has mounted, so they wait here until it asks. Bounded: a chat takes all of its
// own at once, and nothing else ever puts anything in.
const pending = new Map<string, Intake[]>();

export function pushIntake(chatId: string, intake: Intake) {
  pending.set(chatId, [...(pending.get(chatId) ?? []), intake]);
  window.dispatchEvent(new CustomEvent("capka:intake", { detail: chatId }));
}

export function takeIntake(chatId: string): Intake[] {
  const list = pending.get(chatId) ?? [];
  pending.delete(chatId);
  return list;
}
