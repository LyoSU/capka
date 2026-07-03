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

  it("ignores model/binary blobs by extension (case-insensitive)", () => {
    expect(ignoredPath("models/llama-7b.gguf")).toBe(true);
    expect(ignoredPath("weights.SAFETENSORS")).toBe(true);
    expect(ignoredPath("a/b/model.onnx")).toBe(true);
  });

  it("ignores editor/OS lock and junk files", () => {
    expect(ignoredPath("docs/~$report.docx")).toBe(true);
    expect(ignoredPath("Thumbs.db")).toBe(true);
    expect(ignoredPath("sheet/.~lock.budget.ods#")).toBe(true);
  });

  it("keeps ordinary documents and code", () => {
    expect(ignoredPath("report.docx")).toBe(false);
    expect(ignoredPath("src/index.ts")).toBe(false);
    expect(ignoredPath("data/sales.csv")).toBe(false);
    expect(ignoredPath("notes/todo.md")).toBe(false);
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
