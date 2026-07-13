import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_IMPORT_SCRIPT, IMPORT_PROJECTIONS } from "../sandbox-script";
import { parseGrokResponses, parseClaudeSnapshot, parseChatGptState, normalizeImport } from "../parse";
import { MAX_IMPORT_MESSAGES, MAX_IMPORT_MESSAGE_CHARS, MAX_IMPORT_TOTAL_CHARS } from "../types";

// The sandbox script is shipped as a string, so tsc/eslint never see its body.
// These tests are the static safety net: (1) the string must PARSE, and must
// stay free of backticks/template interpolation (it is embedded in a template
// literal — a valid-looking `${ident}` would silently inline platform-side
// values); (2) the bootstrap path (args decode → playwright resolve → emit)
// must produce a sentinel-wrapped payload when run by a real node with no
// playwright available, proving the platform can always extract SOMETHING.
describe("SANDBOX_IMPORT_SCRIPT", () => {
  it("parses as JavaScript and contains no template-literal syntax", () => {
    // Parse-only check of a static constant from our own source (never called,
    // no interpolation) — not an eval of untrusted input.
    expect(() => new Function(SANDBOX_IMPORT_SCRIPT)).not.toThrow();
    expect(SANDBOX_IMPORT_SCRIPT).not.toContain("`");
    expect(SANDBOX_IMPORT_SCRIPT).not.toContain("${");
  });

  it("emits a sentinel-wrapped PLAYWRIGHT_MISSING when playwright can't resolve", () => {
    // Run from a temp dir OUTSIDE the repo so require("playwright") finds
    // neither the project's node_modules nor (NODE_PATH blanked) the global one.
    const dir = mkdtempSync(join(tmpdir(), "capka-import-test-"));
    const file = join(dir, "capka-import.cjs");
    writeFileSync(file, SANDBOX_IMPORT_SCRIPT);
    try {
      const stdout = execFileSync(process.execPath, [file], {
        cwd: dir,
        env: {
          ...process.env,
          NODE_PATH: "",
          CAPKA_IMPORT_ARGS: Buffer.from(
            JSON.stringify({ url: "https://example.com", source: "claude" }),
          ).toString("base64"),
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      const s = stdout.indexOf("<<<CAPKA_IMPORT>>>");
      const e = stdout.indexOf("<<<CAPKA_END>>>");
      expect(s).toBeGreaterThanOrEqual(0);
      expect(e).toBeGreaterThan(s);
      const payload = JSON.parse(stdout.slice(s + "<<<CAPKA_IMPORT>>>".length, e));
      expect(payload).toEqual({ ok: false, code: "PLAYWRIGHT_MISSING" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// The projection helpers run inside the sandbox (spliced into the script
// string), so exercise them here directly. Static constant from our own source
// — same pattern as the parse check above, not an eval of untrusted input.
const proj = new Function(
  "name",
  "json",
  "caps",
  IMPORT_PROJECTIONS +
    "return { grok: projectGrokImport, claude: projectClaudeImport, chatgpt: projectChatGptImport }[name](json, caps);",
) as (name: "grok" | "claude" | "chatgpt", json: unknown, caps: unknown) => Record<string, unknown>;

const CAPS = {
  maxMessages: MAX_IMPORT_MESSAGES,
  maxMsgChars: MAX_IMPORT_MESSAGE_CHARS,
  maxTotalBytes: MAX_IMPORT_TOTAL_CHARS + MAX_IMPORT_MESSAGE_CHARS,
};

describe("import projections", () => {
  it("grok: strips steps/webSearchResults dead weight but parses to the same messages", () => {
    // Regression for the real failure: a share whose payload was ~94% fields the
    // parser discards (steps, full webSearchResults) tripped the controller's
    // stdout ceiling and failed the whole import.
    const full = {
      conversation: { title: "Big one", conversationId: "x", extra: "y".repeat(1000) },
      responses: [
        { sender: "human", message: "питання", steps: [{ log: "z".repeat(400_000) }] },
        {
          sender: "ASSISTANT",
          message: "відповідь",
          steps: [{ log: "z".repeat(400_000) }],
          webSearchResults: [{ snippet: "w".repeat(300_000) }],
        },
      ],
    };
    const slim = proj("grok", full, CAPS);
    expect(JSON.stringify(slim).length).toBeLessThan(2_000);
    expect(parseGrokResponses(slim)).toEqual(parseGrokResponses(full));
  });

  it("grok: keeps the +ε overage so normalizeImport clips and flags long messages itself", () => {
    const full = {
      conversation: { title: "t" },
      responses: [{ sender: "human", message: "x".repeat(MAX_IMPORT_MESSAGE_CHARS + 5_000) }],
    };
    const slim = proj("grok", full, CAPS);
    const norm = normalizeImport(parseGrokResponses(slim));
    expect(norm.truncated).toBe(true);
    expect(norm.messages[0].content.length).toBeLessThanOrEqual(MAX_IMPORT_MESSAGE_CHARS + 8);
  });

  it("grok: message-count overflow survives projection as truncated", () => {
    const full = {
      conversation: { title: "t" },
      responses: Array.from({ length: MAX_IMPORT_MESSAGES + 40 }, (_, i) => ({
        sender: i % 2 ? "ASSISTANT" : "human",
        message: `msg ${i}`,
      })),
    };
    const norm = normalizeImport(parseGrokResponses(proj("grok", full, CAPS)));
    expect(norm.truncated).toBe(true);
    expect(norm.messages.length).toBe(MAX_IMPORT_MESSAGES);
  });

  it("grok: byte budget drops the tail and flags __capkaTruncated (multi-byte text)", () => {
    // Cyrillic is 2 bytes/char, so the byte budget bites before the char caps —
    // the platform can't observe those dropped messages, the flag must carry it.
    const full = {
      conversation: { title: "t" },
      responses: Array.from({ length: 20 }, () => ({ sender: "human", message: "ц".repeat(90_000) })),
    };
    const slim = proj("grok", full, CAPS);
    expect(slim.__capkaTruncated).toBe(true);
    const norm = normalizeImport(parseGrokResponses(slim));
    expect(norm.truncated).toBe(true);
    expect(norm.messages.length).toBeGreaterThan(0);
  });

  it("claude: projects text blocks, keeps the flat-text fallback, and carries rich content", () => {
    const full = {
      snapshot_name: "Snap",
      chat_messages: [
        {
          sender: "human",
          text: "",
          content: [
            { type: "text", text: "перший блок" },
            { type: "tool_use", input: { big: "q".repeat(500_000) } },
            { type: "text", text: "другий блок" },
          ],
        },
        { sender: "assistant", text: "лише плаский текст", content: [{ type: "thinking", thinking: "w".repeat(200_000) }] },
        { sender: "human", text: "з файлом", content: [{ type: "text", text: "з файлом" }], attachments: [{ file_name: "a.pdf" }] },
      ],
    };
    const slim = proj("claude", full, CAPS);
    expect(JSON.stringify(slim).length).toBeLessThan(2_000);
    expect(parseClaudeSnapshot(slim)).toEqual(parseClaudeSnapshot(full));
  });

  it("chatgpt: slims mapping nodes (drops metadata) but the branch walk still matches", () => {
    const full = {
      title: "Tree",
      current_node: "c",
      mapping: {
        a: { parent: null, children: ["b"], message: null },
        b: {
          parent: "a",
          children: ["c"],
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["привіт"] },
            metadata: { search_results: [{ body: "m".repeat(400_000) }] },
          },
        },
        c: {
          parent: "b",
          children: [],
          message: {
            author: { role: "assistant" },
            content: { content_type: "multimodal_text", parts: ["текст і", { asset_pointer: "img" }] },
            metadata: { huge: "n".repeat(300_000) },
          },
        },
      },
    };
    const slim = proj("chatgpt", full, CAPS);
    expect(JSON.stringify(slim).length).toBeLessThan(2_000);
    expect(parseChatGptState(slim)).toEqual(parseChatGptState(full));
  });
});
