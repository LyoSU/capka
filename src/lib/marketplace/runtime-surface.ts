import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpServers, skills, pluginFiles } from "@/lib/db/schema";
import { decrypt, fingerprint } from "@/lib/crypto";
import { canonicalTypedValue, contentHash, normalizeEndpoint, rootHash } from "./canonical";
import { hasUnresolvedPlaceholder, refsPluginRoot, serverDefParts } from "./plugin-root";
import {
  SURFACE_SCHEMA_VERSION,
  type StoredInstallSurface, type StoredSurfaceConnector, type StoredSurfaceSkill,
} from "./surface";

/**
 * `runtimeBefore` — what an apply would actually OVERWRITE, read from the rows
 * (docs/plugin-install-review-spec.md §6).
 *
 * The gate reads this axis rather than `sourceBefore`, because a hand-edited row is a real
 * thing an apply destroys even when the author shipped nothing.
 *
 * ## What the rows cannot tell us
 *
 * Some of the surface is an ARTIFACT property that the row does not record. The clearest
 * case is a remote connector installed with a `${...}` placeholder: `applyPlanResources`
 * deliberately does not persist those headers, so the row has no `secrets` at all and the
 * header NAMES are simply gone.
 *
 * Reconstructing those fields from the row would therefore invent a difference on every
 * upgrade of every placeholder connector — `needsSecret: true → false`, forever, which the
 * delta correctly classifies as a `replacement` requiring consent. A permanent false
 * positive is worse than useless in a consent screen: it teaches the reader that the
 * warnings are noise.
 *
 * So this function reports what the ROW genuinely knows — existence, endpoint, transport,
 * command line, and the owner's actual `enabled` choice — and takes the rest from the
 * committed artifact for any resource that matches one by name. Where there is no committed
 * counterpart, the field is reported as unknown-shaped (`needsSecret: false`, no
 * `secretKeys`), which reads as an `expansion` rather than as a false change.
 */

const EMPTY_FILES = { projection: "stored" as const, count: 0, bytes: 0, rootHash: rootHash([]), entrypoints: [], files: [] };

/** The baseline for something that does not exist yet — a FIRST install. Distinct from
 *  `null`, which means a baseline could not be established at all: an empty baseline is
 *  known, so everything against it is an `expansion` (consent required, which is exactly
 *  what a first install's own Install button provides). */
export function emptySurface(): StoredInstallSurface {
  return { schemaVersion: SURFACE_SCHEMA_VERSION, completeness: "derived", connectors: [], skills: [], files: EMPTY_FILES };
}

/** Within one install a resource's identity IS its name — `upsertServer` dedupes on
 *  `(scope, owner, name, source)` and a policy keys on the name alone. The committed
 *  surface supplies the `originKey` the row does not carry; a row with no committed
 *  counterpart gets a bare `#name`, which cannot collide with a real manifest path. */
function originKeyFor(committed: StoredInstallSurface | null, name: string): string {
  return committed?.connectors.find((c) => c.name === name)?.originKey ?? `#${name}`;
}

export async function readRuntimeSurface(
  installId: string,
  committed: StoredInstallSurface | null,
  keyHex: string,
): Promise<StoredInstallSurface> {
  const tag = `catalog:${installId}`;
  const [connectorRows, skillRows, fileRows] = await Promise.all([
    db.select().from(mcpServers).where(eq(mcpServers.source, tag)),
    db.select().from(skills).where(eq(skills.source, tag)),
    db.select({ path: pluginFiles.path, content: pluginFiles.content }).from(pluginFiles).where(eq(pluginFiles.installId, installId)),
  ]);

  const connectors: StoredSurfaceConnector[] = connectorRows.map((r): StoredSurfaceConnector => {
    const prior = committed?.connectors.find((c) => c.name === r.name);
    let env: Record<string, string> | undefined;
    let headerKeys: string[] | undefined;
    if (r.secrets) {
      try {
        const parsed = JSON.parse(decrypt(r.secrets, keyHex)) as { env?: Record<string, string>; headers?: Record<string, string> };
        env = parsed.env;
        headerKeys = parsed.headers ? Object.keys(parsed.headers).sort() : undefined;
      } catch { /* an undecryptable secret tells us nothing; fall through to the artifact */ }
    }
    const stdio = r.transport === "stdio";
    const args = (r.args as string[] | null) ?? [];
    return {
      projection: "stored",
      name: r.name,
      originKey: originKeyFor(committed, r.name),
      transport: r.transport as "http" | "sse" | "stdio",
      ...(r.url ? { endpoint: normalizeEndpoint(r.url) ?? undefined } : {}),
      ...(stdio ? {} : { authKind: r.authKind as "token" | "oauth" }),
      // Header/env NAMES from the row when it has them, otherwise from the artifact: a
      // placeholder connector persisted none, and inventing their absence would read as a
      // credential change on every upgrade.
      secretKeys: (stdio ? (env ? Object.keys(env).sort() : undefined) : headerKeys) ?? prior?.secretKeys ?? [],
      needsSecret: stdio
        ? (env ? Object.values(env).some(hasUnresolvedPlaceholder) : prior?.needsSecret ?? false)
        : prior?.needsSecret ?? false,
      runsThirdPartyCode: stdio,
      bundled: stdio ? refsPluginRoot(serverDefParts({ command: r.command ?? undefined, args, env })) : false,
      // The one field where the runtime axis says something the artifact never can: the
      // owner's actual choice, which is what an apply would overwrite.
      activation: r.enabled ? "enabled" : "disabled",
      ...(stdio
        ? {
            execution: {
              binary: r.command ?? "",
              argCount: args.length,
              placeholderArgs: args.flatMap((a, i) => (/\$\{[^}]+\}/.test(a) ? [i] : [])),
              fingerprint: fingerprint(
                canonicalTypedValue("execution", { command: r.command ?? "", args, env: env ?? {} }), keyHex),
            },
          }
        : {}),
    };
  }).sort((a, b) => (a.originKey < b.originKey ? -1 : a.originKey > b.originKey ? 1 : 0));

  const skillSurface: StoredSurfaceSkill[] = skillRows.map((r) => {
    const prior = committed?.skills.find((s) => s.name === r.name);
    return {
      projection: "stored" as const,
      name: r.name,
      // `originPath` is an artifact property; the row keeps only the body. Taking it from
      // the artifact avoids reporting a moved file where nothing moved.
      originPath: prior?.originPath ?? `skills/${r.name}`,
      // The row stores the PARSED body, not the raw file, so a hash of it would never equal
      // the artifact's `instructionHash` over the raw SKILL.md. The artifact's value is the
      // only one comparable with `sourceAfter`; where there is none, a hash of the body at
      // least changes when the body does.
      instructionHash: prior?.instructionHash ?? contentHash(r.body),
      filesRootHash: prior?.filesRootHash ?? rootHash([]),
    };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const files = fileRows.map((f) => {
    const bytes = Buffer.from(f.content, "base64");
    return { path: f.path, bytes: bytes.byteLength, contentHash: contentHash(bytes) };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schemaVersion: SURFACE_SCHEMA_VERSION,
    // `reconstructed`, never `derived`: a reader has to be able to tell that some of this
    // came from the committed artifact rather than from the rows themselves.
    completeness: "reconstructed",
    connectors,
    skills: skillSurface,
    files: files.length
      ? { projection: "stored", count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0),
          rootHash: rootHash(files), entrypoints: committed?.files.entrypoints ?? [], files }
      : EMPTY_FILES,
  };
}
