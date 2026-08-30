import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const KEY_RE = /^[0-9a-f]{64}$/;
/** `||`, not `??`: docker-compose passes `${VAULT_CAS_DIR:-}`, which is an EMPTY
 *  STRING rather than an absent variable. `??` let it through, the root became "",
 *  and every blob path came out relative to the process cwd — outside the `./data`
 *  mount that the compose file and .env.example both promise. An empty value means
 *  "not configured", the same as unset. */
function root(): string {
  return process.env.VAULT_CAS_DIR || path.join(process.cwd(), "data", "vault-cas");
}
export function blobPath(sha256: string): string {
  if (!KEY_RE.test(sha256)) throw new Error("invalid CAS key");
  return path.join(root(), sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}
export async function putBlob(bytes: Buffer): Promise<string> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dest = blobPath(sha);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${randomUUID()}.tmp`);
  await writeFile(tmp, bytes);
  try {
    await link(tmp, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return sha;
}
export async function readBlob(sha256: string): Promise<Buffer> {
  return readFile(blobPath(sha256));
}
