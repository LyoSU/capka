import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `run` inside `loadSandboxTools` is the single place a command's environment is set and
 * its output is scrubbed, and the two are deliberately NOT the same set.
 *
 * INJECT is per chat: only this chat's own credentials may reach the container.
 * REDACT is per WORKSPACE, because the workspace is. A session (and its `/workspace`
 * bind mount) is keyed by `projectId ?? chatId`, a detached background job inherits the
 * starting chat's secret env and tees its raw output into `/workspace/.capka/jobs/<id>/log` there,
 * and a sibling chat reads that file with an ordinary tool call. While the redactor was
 * built from the injected env alone, that sibling's turn knew nothing about the value and
 * handed the model the plaintext.
 */
const { execCommand, deleteFile, markBusy, loadRedactionSecrets } = vi.hoisted(() => ({
  execCommand: vi.fn(),
  deleteFile: vi.fn(),
  markBusy: vi.fn().mockResolvedValue(undefined),
  loadRedactionSecrets: vi.fn(),
}));
vi.mock("../client", () => ({ execCommand, deleteFile, markBusy }));
// The redactor itself is the real one; only the database lookup behind the workspace
// union is replaced.
vi.mock("@/lib/chat/secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/secrets")>();
  return { ...actual, loadRedactionSecrets };
});

import { loadSandboxTools } from "../tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = {} as any;
const OWN = { OWN_TOKEN: "sk-own-abcdef" };

const load = () =>
  loadSandboxTools("proj1", "user1", async () => {}, "none", undefined, async () => OWN);

beforeEach(() => {
  execCommand.mockReset().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  loadRedactionSecrets.mockReset().mockResolvedValue([]);
});

describe("loadSandboxTools — secret scope", () => {
  it("injects only this chat's own secrets, whatever the workspace holds", async () => {
    loadRedactionSecrets.mockResolvedValue([
      ["OWN_TOKEN", "sk-own-abcdef"],
      ["SIBLING_TOKEN", "sk-sibling-abcdef"],
    ]);
    const { tools } = await load();
    await tools.execute_bash.execute!({ command: "env" }, opts);
    // The env argument to the controller is the 5th. A sibling chat's credential must
    // never reach this container: sharing a workspace is not sharing an identity.
    expect(execCommand.mock.calls[0][4]).toEqual(OWN);
  });

  it("redacts a sibling chat's secret out of a shared-workspace job log", async () => {
    // Exactly the reported path: chat A's background job wrote its own token into
    // /workspace/.capka/jobs/<id>/log, and this turn belongs to chat B.
    loadRedactionSecrets.mockResolvedValue([["SIBLING_TOKEN", "sk-sibling-abcdef"]]);
    execCommand.mockResolvedValue({
      stdout: "AUTH=sk-sibling-abcdef\n",
      stderr: "failed with sk-sibling-abcdef",
      exitCode: 1,
    });
    const { tools } = await load();
    // `execute_bash` folds stdout and any residual stderr into one `output` field.
    const res = (await tools.execute_bash.execute!(
      { command: "cat /workspace/.capka/jobs/j1/log" },
      opts,
    )) as { output: string };
    expect(res.output).not.toContain("sk-sibling-abcdef");
    expect(res.output).toContain("[secret:SIBLING_TOKEN]");
    // Both streams go through the same redactor, so the stderr half is covered too.
    expect(res.output.match(/\[secret:SIBLING_TOKEN\]/g)).toHaveLength(2);
  });

  it("scopes the workspace lookup to the session key and the caller", async () => {
    const { tools } = await load();
    await tools.execute_bash.execute!({ command: "true" }, opts);
    expect(loadRedactionSecrets).toHaveBeenCalledWith("proj1", "user1");
  });

  it("resolves the workspace union once per turn, not once per command", async () => {
    const { tools } = await load();
    await tools.execute_bash.execute!({ command: "a" }, opts);
    await tools.execute_bash.execute!({ command: "b" }, opts);
    expect(loadRedactionSecrets).toHaveBeenCalledTimes(1);
  });

  it("refuses the command outright when the union cannot be read", async () => {
    // FAIL CLOSED. Degrading to this chat's own values read as a safe fallback and was
    // not one: the values in hand are exactly the injected ones, and the union exists for
    // the values that are NOT — a sibling chat's credential in a shared job log. So a
    // database hiccup switched the leak back on for the only case that needed the union.
    // Refusing BEFORE the exec is what makes "nothing leaves here unredacted" hold.
    loadRedactionSecrets.mockRejectedValue(new Error("db down"));
    const { tools } = await load();

    await expect(
      tools.execute_bash.execute!({ command: "cat /workspace/.capka/jobs/j1/log" }, opts),
    ).rejects.toThrow(/could not be loaded/i);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("retries the union on the next command instead of caching the failure", async () => {
    // One bad moment must not disable every remaining command of the turn — the memo is
    // dropped on rejection, so the next call asks again.
    loadRedactionSecrets.mockRejectedValueOnce(new Error("db down"));
    loadRedactionSecrets.mockResolvedValue([["SIBLING_TOKEN", "sk-sibling-abcdef"]]);
    execCommand.mockResolvedValue({ stdout: "AUTH=sk-sibling-abcdef", stderr: "", exitCode: 0 });
    const { tools } = await load();

    await expect(tools.execute_bash.execute!({ command: "a" }, opts)).rejects.toThrow();
    const res = (await tools.execute_bash.execute!({ command: "b" }, opts)) as { output: string };

    expect(loadRedactionSecrets).toHaveBeenCalledTimes(2);
    expect(res.output).toContain("[secret:SIBLING_TOKEN]");
    expect(res.output).not.toContain("sk-sibling-abcdef");
  });

  it("looks nothing up for a run with no chat", async () => {
    const { tools } = await loadSandboxTools("proj1", "user1", async () => {});
    await tools.execute_bash.execute!({ command: "true" }, opts);
    expect(loadRedactionSecrets).not.toHaveBeenCalled();
  });
});
