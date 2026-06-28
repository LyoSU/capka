import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createSession,
  execCommand,
  listFiles,
  destroySession,
} from "@/lib/sandbox/client";

// Opt-in: requires a running sandbox-controller + Docker.
//   RUN_INTEGRATION=1 SANDBOX_CONTROLLER_URL=http://localhost:3001 \
//   CONTROLLER_SECRET=... node_modules/.bin/vitest run workspaces.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const USER = "wstest-user";
const PROJECT_KEY = "wstest-proj"; // sessionKey when chats share a project
const SOLO_KEY = "wstest-solo"; // sessionKey for a standalone chat

run("project workspaces (controller two-mount)", () => {
  beforeAll(async () => {
    await createSession(PROJECT_KEY, USER);
    await createSession(SOLO_KEY, USER);
  });

  afterAll(async () => {
    // Best-effort cleanup of files + containers.
    await execCommand(PROJECT_KEY, "rm -f /workspace/projfile.txt /shared/globalfile.txt", 5000).catch(() => {});
    await destroySession(PROJECT_KEY, USER).catch(() => {});
    await destroySession(SOLO_KEY, USER).catch(() => {});
  });

  it("shares /workspace across sessions that use the same project key", async () => {
    await execCommand(PROJECT_KEY, "echo hello-project > /workspace/projfile.txt", 5000);
    const { entries } = await listFiles(PROJECT_KEY, ".", USER);
    expect(entries.map((e) => e.name)).toContain("projfile.txt");
  });

  it("isolates a standalone workspace from the project workspace", async () => {
    const { entries } = await listFiles(SOLO_KEY, ".", USER);
    expect(entries.map((e) => e.name)).not.toContain("projfile.txt");
  });

  it("exposes the per-user /shared folder to every session", async () => {
    await execCommand(PROJECT_KEY, "echo hello-global > /shared/globalfile.txt", 5000);
    const fromSolo = await execCommand(SOLO_KEY, "cat /shared/globalfile.txt", 5000);
    expect(fromSolo.exitCode).toBe(0);
    expect(fromSolo.stdout.trim()).toBe("hello-global");
  });
});
