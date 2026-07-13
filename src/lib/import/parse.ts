import {
  MAX_IMPORT_MESSAGES,
  MAX_IMPORT_MESSAGE_CHARS,
  MAX_IMPORT_TOTAL_CHARS,
  type ImportedMessage,
  type ImportSource,
  type SharedChatImport,
} from "./types";

/**
 * Pure parsers: raw provider payload → a normalized `SharedChatImport`.
 *
 * The raw payload is UNTRUSTED (it came from an attacker-controllable public
 * page via the sandbox), so every field is read defensively and the output is
 * capped + sanitized by `normalizeImport`. These functions never touch the
 * network or the DB, so they're exhaustively fixture-testable.
 */

// ── Safe readers ─────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ── Claude (claude.ai/share) ─────────────────────────────────
//
// Verified snapshot shape (GET /api/chat_snapshots/<uuid>?rendering_mode=messages):
//   { snapshot_name, chat_messages: [{ sender:"human"|"assistant",
//       text, content:[{type:"text",text}|{type:"tool_use"}|{type:"tool_result"}
//       |{type:"thinking"}|{type:"image"}], attachments, files, image_count,
//       file_count }] }
// The flat `text` is often empty in this rendering mode — the real text lives in
// the `content[]` text blocks, so we reconstruct from there and only fall back
// to `text`. Tool/thinking/image blocks (and any attachments/files) are dropped;
// their presence flips `droppedRichContent`.

export function parseClaudeSnapshot(raw: unknown): SharedChatImport {
  const root = asRecord(raw);
  const title = root ? asString(root.snapshot_name).trim() || null : null;
  const messages: ImportedMessage[] = [];
  let droppedRichContent = false;

  for (const m of asArray(root?.chat_messages)) {
    const msg = asRecord(m);
    if (!msg) continue;
    // Strict role whitelist: only the two known senders map through; anything
    // else (a future/unknown sender) is dropped rather than silently coerced to
    // assistant, which could mislabel who said what.
    let role: ImportedMessage["role"];
    if (msg.sender === "human") role = "user";
    else if (msg.sender === "assistant") role = "assistant";
    else {
      droppedRichContent = true;
      continue;
    }

    const textBlocks: string[] = [];
    let sawRich = false;
    for (const block of asArray(msg.content)) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type === "text") {
        const t = asString(b.text);
        if (t) textBlocks.push(t);
      } else {
        // tool_use / tool_result / thinking / image / anything else → not imported.
        sawRich = true;
      }
    }
    // Fall back to the flat field if the content array carried no text.
    let content = textBlocks.join("\n\n").trim();
    if (!content) content = asString(msg.text).trim();

    // Attachments / uploaded files / images are dropped even when text survives.
    if (
      sawRich ||
      asArray(msg.attachments).length > 0 ||
      asArray(msg.files).length > 0 ||
      Number(msg.image_count) > 0 ||
      Number(msg.file_count) > 0
    ) {
      droppedRichContent = true;
    }

    if (content) messages.push({ role, content });
  }

  return { source: "claude", title, messages, truncated: false, droppedRichContent };
}

// ── ChatGPT (chatgpt.com/share) ──────────────────────────────
//
// Classic conversation shape embedded in the share page:
//   { title, current_node, mapping: { <id>: { message: { author:{role},
//       content:{ content_type:"text", parts:[...] } }, parent, children } } }
// We walk from `current_node` up through `parent` to the root, then reverse, so
// we follow the exact branch the sharer left visible. Only user/assistant turns
// with a plain-text body are imported; system/tool turns and non-text content
// (multimodal, code interpreter, DALL·E) are dropped → `droppedRichContent`.

export function parseChatGptState(raw: unknown): SharedChatImport {
  const root = asRecord(raw);
  const title = root ? asString(root.title).trim() || null : null;
  const mapping = asRecord(root?.mapping);
  const messages: ImportedMessage[] = [];
  let droppedRichContent = false;

  if (!mapping) return { source: "chatgpt", title, messages, truncated: false, droppedRichContent };

  // Order the branch leaf → root by following parents, then reverse to root → leaf.
  const chain: string[] = [];
  const seen = new Set<string>();
  const cursor = asString(root?.current_node);
  if (cursor && mapping[cursor]) {
    let c: string = cursor;
    while (c && !seen.has(c)) {
      seen.add(c);
      chain.push(c);
      c = asString(asRecord(mapping[c])?.parent);
    }
    chain.reverse();
  } else {
    // No usable current_node (older/edge payloads): descend deterministically
    // from the root through the LAST child of each node (ChatGPT's convention
    // for the active branch), so we follow one coherent branch instead of mixing
    // siblings in mapping insertion order. No root → nothing importable.
    let node: string | undefined = Object.keys(mapping).find((id) => {
      const parent = asString(asRecord(mapping[id])?.parent);
      return !parent || !mapping[parent];
    });
    while (node && !seen.has(node)) {
      seen.add(node);
      chain.push(node);
      const children = asArray(asRecord(mapping[node])?.children).filter(
        (c): c is string => typeof c === "string",
      );
      node = children.length ? children[children.length - 1] : undefined;
    }
  }

  for (const id of chain) {
    const node = asRecord(mapping[id]);
    const message = asRecord(node?.message);
    if (!message) continue;
    const author = asRecord(message.author);
    const rawRole = asString(author?.role);
    if (rawRole !== "user" && rawRole !== "assistant") {
      // system turns are skipped silently; a tool turn is rich content we drop.
      if (rawRole === "tool") droppedRichContent = true;
      continue;
    }

    const contentObj = asRecord(message.content);
    const contentType = asString(contentObj?.content_type);
    const parts = asArray(contentObj?.parts);
    // Only plain text. Multimodal/code/tether/etc. carry non-string parts or a
    // non-"text" content_type — drop the turn's rich payload.
    const textParts = parts.filter((p) => typeof p === "string") as string[];
    if (contentType !== "text" || textParts.length !== parts.length) droppedRichContent = true;

    const content = textParts.join("\n\n").trim();
    if (content) messages.push({ role: rawRole, content });
  }

  return { source: "chatgpt", title, messages, truncated: false, droppedRichContent };
}

// ── Grok (grok.com/share) ────────────────────────────────────
//
// Verified shape (GET /rest/app-chat/share_links/<id> — WITHOUT ?useChunk, which
// blanks the `message` fields):
//   { conversation: { title, conversationId, ... },
//     responses: [{ sender:"human"|"ASSISTANT", message, webSearchResults[],
//       xposts[], xpostIds[], generatedImageUrls[], imageAttachments[],
//       fileAttachments[], ... }] }
// `message` is the markdown source. `sender` casing is inconsistent across a
// single conversation, so role is decided case-insensitively. Any non-empty
// search/xpost/image/file field is rich content we don't import (text survives).

export function parseGrokResponses(raw: unknown): SharedChatImport {
  const root = asRecord(raw);
  const conversation = asRecord(root?.conversation);
  const title = conversation ? asString(conversation.title).trim() || null : null;
  const messages: ImportedMessage[] = [];
  let droppedRichContent = false;

  for (const r of asArray(root?.responses)) {
    const resp = asRecord(r);
    if (!resp) continue;
    // `sender` casing is inconsistent within one conversation, so compare
    // case-insensitively — but still whitelist strictly: an unknown sender is
    // dropped, not coerced to assistant.
    const sender = asString(resp.sender).toLowerCase();
    let role: ImportedMessage["role"];
    if (sender === "human") role = "user";
    else if (sender === "assistant") role = "assistant";
    else {
      droppedRichContent = true;
      continue;
    }
    const content = asString(resp.message).trim();

    if (
      asArray(resp.webSearchResults).length > 0 ||
      asArray(resp.xposts).length > 0 ||
      asArray(resp.xpostIds).length > 0 ||
      asArray(resp.generatedImageUrls).length > 0 ||
      asArray(resp.imageAttachments).length > 0 ||
      asArray(resp.fileAttachments).length > 0
    ) {
      droppedRichContent = true;
    }

    if (content) messages.push({ role, content });
  }

  return { source: "grok", title, messages, truncated: false, droppedRichContent };
}

// ── Gemini (share.gemini.google / gemini.google.com/share) ───
//
// Gemini has no share JSON API, so the sandbox script scrapes the rendered DOM
// (<share-turn-viewer> per turn) and hands back an already-flattened shape:
//   { title, turns: [{ query, response }], droppedRichContent }
// `response` is the sandbox's HTML→markdown conversion. Here we only validate the
// form and map each turn to a user + assistant message, skipping empty sides.
// `droppedRichContent` (images/attachments the script saw in a turn) is passed
// through as the script observed it.

export function parseGeminiTurns(raw: unknown): SharedChatImport {
  const root = asRecord(raw);
  const title = root ? asString(root.title).trim() || null : null;
  const messages: ImportedMessage[] = [];

  for (const t of asArray(root?.turns)) {
    const turn = asRecord(t);
    if (!turn) continue;
    const query = asString(turn.query).trim();
    const response = asString(turn.response).trim();
    if (query) messages.push({ role: "user", content: query });
    if (response) messages.push({ role: "assistant", content: response });
  }

  return { source: "gemini", title, messages, truncated: false, droppedRichContent: Boolean(root?.droppedRichContent) };
}

/** Dispatch to the right parser for a rendered payload. */
export function parseSharedChat(source: ImportSource, raw: unknown): SharedChatImport {
  switch (source) {
    case "claude":
      return parseClaudeSnapshot(raw);
    case "chatgpt":
      return parseChatGptState(raw);
    case "grok":
      return parseGrokResponses(raw);
    case "gemini":
      return parseGeminiTurns(raw);
  }
}

// ── Normalize (caps + sanitize) ──────────────────────────────

// Control characters have no place in imported prose and can hide injected
// directives from a human reviewing the preview. We keep tab (0x09) and newline
// (0x0A); everything else in the C0 range plus DEL (0x7F) is stripped.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitize(text: string): string {
  // Normalize CRLF/CR to \n first, then strip the remaining control bytes.
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
}

/**
 * Apply the hard caps and sanitize every message. Runs on BOTH preview and
 * commit — the commit path never trusts that the client sent back what preview
 * produced, so the caps are enforced server-side regardless of source. Recomputes
 * `truncated` from whatever was actually dropped here.
 */
export function normalizeImport(imp: SharedChatImport): SharedChatImport {
  let truncated = imp.truncated;
  const out: ImportedMessage[] = [];
  let total = 0;

  for (const m of imp.messages) {
    if (out.length >= MAX_IMPORT_MESSAGES) {
      truncated = true;
      break;
    }
    let content = sanitize(m.content).trim();
    if (!content) continue;
    if (content.length > MAX_IMPORT_MESSAGE_CHARS) {
      content = content.slice(0, MAX_IMPORT_MESSAGE_CHARS) + "\n\n[…]";
      truncated = true;
    }
    if (total + content.length > MAX_IMPORT_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    total += content.length;
    out.push({ role: m.role, content });
  }

  // The Anthropic Messages API requires the first message to be a user turn.
  // Enforce this on the FINAL list, not the source: a message can be non-empty
  // in the source yet sanitize to nothing (control-chars only) and be skipped
  // above, leaving a now-leading assistant turn that must still be dropped.
  const firstUser = out.findIndex((m) => m.role === "user");
  if (firstUser === -1) {
    if (out.length > 0) truncated = true;
    out.length = 0;
  } else if (firstUser > 0) {
    out.splice(0, firstUser);
    truncated = true;
  }

  const title = imp.title ? sanitize(imp.title).trim().slice(0, 200) || null : null;
  return { source: imp.source, title, messages: out, truncated, droppedRichContent: imp.droppedRichContent };
}
