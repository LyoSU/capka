import { describe, it, expect, vi, beforeEach } from "vitest";
import AdmZip from "adm-zip";

// The workspace reader is pure over the sandbox client + the skill store; mock
// both so these tests exercise the shape-detection + collection logic with no
// container and no DB.
const listFiles = vi.fn();
const downloadFile = vi.fn();
vi.mock("@/lib/sandbox/client", () => ({
  listFiles: (...a: unknown[]) => listFiles(...a),
  downloadFile: (...a: unknown[]) => downloadFile(...a),
}));
const ingestSkill = vi.fn((..._a: unknown[]) => Promise.resolve("id"));
vi.mock("@/lib/skills/service", () => ({ ingestSkill: (...a: unknown[]) => ingestSkill(...a) }));

import { discoverWorkspaceSkills, ingestWorkspaceSkills, WorkspacePathError } from "../workspace";

const md = (name: string) => `---\nname: ${name}\ndescription: does ${name} things\n---\n\nBody for ${name}.`;
const entriesOf = (paths: string[]) => ({ entries: paths.map((p) => ({ name: p.split("/").pop()!, path: p, isDirectory: false, size: 1, modifiedAt: null })) });
const fileRes = (text: string) => ({ text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as unknown as Response;

const target = { scope: "user" as const, userId: "u1", projectId: null };

beforeEach(() => {
  listFiles.mockReset();
  downloadFile.mockReset();
  ingestSkill.mockReset();
  ingestSkill.mockResolvedValue("id");
});

describe("ingestWorkspaceSkills — repo-shaped directory", () => {
  it("installs every skills/<name>/SKILL.md under the path", async () => {
    listFiles.mockResolvedValue(entriesOf(["pack/skills/foo/SKILL.md", "pack/skills/bar/SKILL.md", "pack/README.md"]));
    downloadFile.mockImplementation((_s: string, p: string) => Promise.resolve(fileRes(md(p.includes("/foo/") ? "foo" : "bar"))));

    const names = await ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: "pack", target });
    expect(names.sort()).toEqual(["bar", "foo"]);
    expect(ingestSkill).toHaveBeenCalledTimes(2);
  });

  it("only:[…] narrows to the named skills", async () => {
    listFiles.mockResolvedValue(entriesOf(["skills/foo/SKILL.md", "skills/bar/SKILL.md"]));
    downloadFile.mockImplementation((_s: string, p: string) => Promise.resolve(fileRes(md(p.includes("/foo/") ? "foo" : "bar"))));
    const names = await ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: ".", target, only: ["foo"] });
    expect(names).toEqual(["foo"]);
  });
});

describe("ingestWorkspaceSkills — a single skill directory carries its bundle", () => {
  it("ingests SKILL.md plus sibling files as the bundle", async () => {
    listFiles.mockResolvedValue(entriesOf(["myskill/SKILL.md", "myskill/reference.md", "myskill/scripts/run.py"]));
    downloadFile.mockImplementation((_s: string, p: string) => Promise.resolve(fileRes(p.endsWith("SKILL.md") ? md("myskill") : "aux")));
    const names = await ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: "myskill", target });
    expect(names).toEqual(["myskill"]);
    const [, files] = ingestSkill.mock.calls[0] as [unknown, { path: string }[]];
    expect(files.map((f) => f.path).sort()).toEqual(["reference.md", "scripts/run.py"]);
  });
});

describe("ingestWorkspaceSkills — pointing at a specific SKILL.md file", () => {
  it("ingests just that one skill even if the folder holds others", async () => {
    // Listing the parent dir returns two skills; targeting one SKILL.md picks only it.
    listFiles.mockResolvedValue(entriesOf(["d/SKILL.md", "d/other/SKILL.md"]));
    downloadFile.mockImplementation((_s: string, p: string) => Promise.resolve(fileRes(md(p === "d/SKILL.md" ? "one" : "two"))));
    const names = await ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: "d/SKILL.md", target });
    expect(names).toEqual(["one"]);
  });
});

describe("ingestWorkspaceSkills — a .zip archive", () => {
  it("downloads and unzips server-side, then ingests the skill", async () => {
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from(md("zipped")));
    zip.addFile("helper.py", Buffer.from("print('x')"));
    const buf = zip.toBuffer();
    downloadFile.mockResolvedValue({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response);

    const names = await ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: "up/skill.zip", target });
    expect(names).toEqual(["zipped"]);
    expect(listFiles).not.toHaveBeenCalled(); // zip path never lists the fs
  });

  it("rejects an over-cap .zip download without buffering it whole (streamed, aborted at the cap)", async () => {
    // A controller streaming a huge file, chunked and WITHOUT Content-Length — the
    // real download shape. readZipCapped must abort once the running total crosses
    // the cap instead of materializing the whole thing then rejecting.
    const CAP = 5 * 1024 * 1024;
    const chunk = new Uint8Array(1024 * 1024); // 1 MB chunks
    let emitted = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (emitted > CAP + 2 * chunk.byteLength) return c.close(); // safety stop
        emitted += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    downloadFile.mockResolvedValue({ body, headers: { get: () => null } } as unknown as Response);

    await expect(ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: "up/huge.zip", target }))
      .rejects.toBeInstanceOf(WorkspacePathError);
    expect(cancelled).toBe(true);         // the reader aborted the stream mid-flight
    void emitted;                          // (exact count is stream-buffering detail)
  });

  it("rejects an over-cap .zip declared via Content-Length up front (no body read at all)", async () => {
    const getReader = vi.fn();
    downloadFile.mockResolvedValue({
      headers: { get: (h: string) => (h === "content-length" ? String(6 * 1024 * 1024) : null) },
      body: { getReader },
    } as unknown as Response);
    await expect(ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: "up/huge.zip", target }))
      .rejects.toBeInstanceOf(WorkspacePathError);
    expect(getReader).not.toHaveBeenCalled(); // rejected before touching the body
  });
});

describe("guards", () => {
  it("rejects a path that tries to escape the workspace", async () => {
    await expect(ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: "../../etc/passwd", target }))
      .rejects.toBeInstanceOf(WorkspacePathError);
  });

  it("errors clearly when the path holds no SKILL.md", async () => {
    listFiles.mockResolvedValue(entriesOf(["notes.txt", "data.csv"]));
    await expect(ingestWorkspaceSkills({ sessionKey: "s1", userId: "u1", path: ".", target }))
      .rejects.toThrow(/SKILL\.md/);
  });

  it("discover lists names without ingesting", async () => {
    listFiles.mockResolvedValue(entriesOf(["skills/a/SKILL.md"]));
    downloadFile.mockResolvedValue(fileRes(md("a")));
    const names = await discoverWorkspaceSkills("s1", "u1", ".");
    expect(names).toEqual(["a"]);
    expect(ingestSkill).not.toHaveBeenCalled();
  });
});
