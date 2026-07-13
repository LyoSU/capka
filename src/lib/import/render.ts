import { nanoid } from "nanoid";
import { createSession, destroySession, execCommand, getSandboxAllowNetwork } from "@/lib/sandbox/client";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { SANDBOX_IMPORT_SCRIPT } from "./sandbox-script";
import type { DetectedShareLink, ImportErrorCode } from "./types";

/**
 * A typed import failure. Carries a machine `code` the client turns into a calm,
 * localized sentence — the raw reason never reaches the user. 422 (unprocessable):
 * the request was well-formed, we just couldn't turn the link into a conversation.
 */
export class ImportError extends AppError {
  readonly reason: ImportErrorCode;
  constructor(reason: ImportErrorCode) {
    super(`Import failed: ${reason}`, 422, `IMPORT_${reason}`);
    this.reason = reason;
  }
}

/**
 * Render a shared conversation in a headless browser INSIDE the sandbox and
 * return its raw provider payload. The untrusted page is fetched and executed in
 * the isolated container — never in the platform process — and only JSON crosses
 * back. Parsing/validation is the caller's job (`parse.ts`).
 *
 * A dedicated one-shot session (`imp-<userId>-<rand>`) keeps import decoupled
 * from any chat's sandbox (there may be no chat yet at preview time) AND from a
 * second concurrent import: two previews (e.g. two tabs) must not share a
 * container, or the first's teardown would wipe the second mid-render. It's
 * created with
 * egress ("bridge"; the controller still gates that on SANDBOX_ALLOW_NETWORK) and
 * torn down when we're done, so an import leaves no lingering container.
 */
export async function renderSharedChat(link: DetectedShareLink, userId: string): Promise<{ raw: unknown }> {
  // Fail fast and clearly when this instance runs the sandbox without egress:
  // spinning a container just to have the fetch time out would be a slow, opaque
  // failure. `null` means "couldn't ask the controller" — treat as unknown and
  // proceed, so a transient blip doesn't mislabel a network-enabled box.
  if ((await getSandboxAllowNetwork()) === false) throw new ImportError("NETWORK_DISABLED");

  const sessionId = `imp-${userId}-${nanoid(8)}`;
  try {
    await createSession(sessionId, userId, "bridge");

    const b64script = Buffer.from(SANDBOX_IMPORT_SCRIPT, "utf8").toString("base64");
    const b64args = Buffer.from(JSON.stringify({ url: link.url, source: link.source }), "utf8").toString("base64");
    // NODE_PATH → global node_modules so the CJS `require("playwright")` resolves
    // no matter where we drop the script. base64 for both the script and the args
    // means no shell metacharacter (or the URL) is ever interpreted.
    const cmd =
      `export NODE_PATH="$(npm root -g 2>/dev/null)"; ` +
      `printf %s '${b64script}' | base64 -d > /tmp/capka-import.cjs && ` +
      `CAPKA_IMPORT_ARGS='${b64args}' node /tmp/capka-import.cjs`;

    // Generous budget: a cold headless-Chromium launch plus navigation and (for
    // ChatGPT) client hydration can run tens of seconds, more when the source
    // throws up a slow bot check before we give up on it.
    const res = await execCommand(sessionId, cmd, 120_000);
    // The controller caps exec output (~1MB); a truncated payload can't be parsed
    // as JSON. Treat an over-large conversation as a clean failure, not a crash.
    if (res.truncated) {
      log.error("share import: render output truncated at controller ceiling", { source: link.source });
      throw new ImportError("RENDER_FAILED");
    }
    const out = (res.stdout || "").trim();
    if (!out) {
      log.error("share import: empty render output", { source: link.source, stderr: res.stderr?.slice(0, 500) });
      throw new ImportError("RENDER_FAILED");
    }

    // The script wraps its JSON in sentinels so we can lift it out cleanly even if
    // the browser/runtime writes stray lines to stdout around it.
    const s = out.indexOf("<<<CAPKA_IMPORT>>>");
    const e = out.indexOf("<<<CAPKA_END>>>");
    if (s < 0 || e < 0 || e < s) {
      log.error("share import: no sentinel in render output", { source: link.source, head: out.slice(0, 300) });
      throw new ImportError("RENDER_FAILED");
    }
    let parsed: { ok?: boolean; raw?: unknown; code?: string };
    try {
      parsed = JSON.parse(out.slice(s + "<<<CAPKA_IMPORT>>>".length, e));
    } catch {
      log.error("share import: unparseable render output", { source: link.source, head: out.slice(0, 300) });
      throw new ImportError("RENDER_FAILED");
    }

    if (parsed.ok && parsed.raw !== undefined) return { raw: parsed.raw };
    const code = (parsed.code as ImportErrorCode) || "RENDER_FAILED";
    throw new ImportError(code);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    // A controller/network fault reaching the sandbox — not the user's problem to
    // parse. Log the detail, surface a generic retryable failure.
    log.error("share import: render orchestration failed", { source: link.source, err: e instanceof Error ? e.message : String(e) });
    throw new ImportError("RENDER_FAILED");
  } finally {
    // Best-effort teardown; idle eviction would get it anyway, but don't leave a
    // browser-heavy container around after a one-shot import.
    await destroySession(sessionId, userId).catch(() => {});
  }
}
