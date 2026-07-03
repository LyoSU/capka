import { describe, it, expect } from "vitest";
import { ignoredPath, oversized, FOLDER_MAX_FILE_MB } from "../filter";

describe("ignoredPath", () => {
  it("ignores dependency/build trees at any depth", () => {
    expect(ignoredPath("node_modules")).toBe(true);
    expect(ignoredPath("src/node_modules/left-pad/index.js")).toBe(true);
    expect(ignoredPath(".git/HEAD")).toBe(true);
    expect(ignoredPath("app/.venv/lib/python3.11/site-packages/x.py")).toBe(true);
    expect(ignoredPath("frontend/dist/bundle.js")).toBe(true);
    expect(ignoredPath("__pycache__")).toBe(true);
  });

  it("ignores newer framework caches, VCS and infra trees", () => {
    expect(ignoredPath("web/.turbo/x")).toBe(true);
    expect(ignoredPath("app/.svelte-kit/generated/root.js")).toBe(true);
    expect(ignoredPath(".terraform/providers/registry")).toBe(true);
    expect(ignoredPath("proj/bower_components/jquery/x.js")).toBe(true);
    expect(ignoredPath("repo/.bzr/x")).toBe(true);
  });

  it("ignores model/binary blobs and disk images by extension (case-insensitive)", () => {
    expect(ignoredPath("models/llama-7b.gguf")).toBe(true);
    expect(ignoredPath("weights.SAFETENSORS")).toBe(true);
    expect(ignoredPath("a/b/model.onnx")).toBe(true);
    expect(ignoredPath("core.mlmodel")).toBe(true);
    expect(ignoredPath("images/win.vhdx")).toBe(true);
    expect(ignoredPath("vm/box.ova")).toBe(true);
  });

  it("ignores macOS/Windows/editor junk files", () => {
    expect(ignoredPath("docs/~$report.docx")).toBe(true);
    expect(ignoredPath("Thumbs.db")).toBe(true);
    expect(ignoredPath("sheet/.~lock.budget.ods#")).toBe(true);
    expect(ignoredPath("photos/._IMG_001.jpg")).toBe(true);   // AppleDouble
    expect(ignoredPath("folder/Desktop.ini")).toBe(true);
    expect(ignoredPath("__MACOSX/foo")).toBe(true);
    expect(ignoredPath("System Volume Information/tracking.log")).toBe(true);
    expect(ignoredPath("src/main.py.swp")).toBe(true);        // vim swap
    expect(ignoredPath("notes.txt~")).toBe(true);             // editor backup
    expect(ignoredPath("build.tmp")).toBe(true);
  });

  it("keeps ordinary documents, code, data and archives", () => {
    expect(ignoredPath("report.docx")).toBe(false);
    expect(ignoredPath("src/index.ts")).toBe(false);
    expect(ignoredPath("data/sales.csv")).toBe(false);
    expect(ignoredPath("notes/todo.md")).toBe(false);
    expect(ignoredPath("backup.zip")).toBe(false);            // archives are user content
    expect(ignoredPath("dataset.h5")).toBe(false);            // HDF5 is scientific data, not just Keras
    expect(ignoredPath("arr.npy")).toBe(false);
    expect(ignoredPath("cfg/.env")).toBe(false);              // small config, user's choice
  });

  it("does not eat legitimate folders with generic English names", () => {
    // Case-sensitive: only lowercase tool output is ignored, not a user's folder.
    expect(ignoredPath("Build/plans.pdf")).toBe(false);
    expect(ignoredPath("Target/goals.docx")).toBe(false);
    expect(ignoredPath("env/notes.txt")).toBe(false);         // bare "env" no longer ignored
    expect(ignoredPath("vendor/contract.pdf")).toBe(false);
    expect(ignoredPath("Coverage/policy.pdf")).toBe(false);
  });

  it("does not treat a substring match as a segment match", () => {
    // "mynode_modules" is not the "node_modules" segment
    expect(ignoredPath("mynode_modules/file.txt")).toBe(false);
    expect(ignoredPath("distance.txt")).toBe(false);
  });
});

describe("oversized", () => {
  it("flags files over the per-file cap", () => {
    expect(oversized(FOLDER_MAX_FILE_MB * 1024 * 1024 + 1)).toBe(true);
    expect(oversized(FOLDER_MAX_FILE_MB * 1024 * 1024)).toBe(false);
    expect(oversized(1024)).toBe(false);
  });
});
