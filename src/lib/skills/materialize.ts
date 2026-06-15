import { execCommand } from "@/lib/sandbox/client";
import { sanitizeBundlePath } from "./paths";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Write one skill's SKILL.md body + bundle files into the sandbox at
 * /skills/<name>/, just-in-time (called from the skill tool). Files are
 * base64-decoded in-container, matching the write pattern in sandbox/tools.ts.
 * Returns the absolute base dir and the list of materialized relative paths.
 */
export async function materializeSkill(
  sessionKey: string,
  name: string,
  body: string,
  files: { path: string; content: string }[],
): Promise<{ baseDir: string; files: string[] }> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`Unsafe skill name: ${name}`);
  const baseDir = `/skills/${name}`;
  const written: string[] = [];

  const writeFile = async (relPath: string, base64: string) => {
    const abs = `${baseDir}/${relPath}`.replace(/'/g, "'\\''");
    const cmd = `mkdir -p "$(dirname '${abs}')" && echo '${base64}' | base64 -d > '${abs}'`;
    await execCommand(sessionKey, cmd, 15000);
  };

  await writeFile("SKILL.md", Buffer.from(body, "utf8").toString("base64"));

  for (const f of files) {
    const safe = sanitizeBundlePath(f.path);
    if (!safe || safe === "SKILL.md") continue;
    await writeFile(safe, f.content);
    written.push(safe);
  }

  return { baseDir, files: written };
}
