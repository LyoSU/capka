import { describe, it, expect } from "vitest";
import { extractWorkspacePaths } from "../artifacts";

describe("extractWorkspacePaths", () => {
  it("captures referenced workspace files in first-seen order, deduped", () => {
    const text = "Saved to /workspace/report.pdf and /workspace/sub/dir/data.csv. Again /workspace/report.pdf.";
    expect(extractWorkspacePaths(text)).toEqual(["report.pdf", "sub/dir/data.csv"]);
  });

  it("rejects path traversal so a model reply can't escape the workspace", () => {
    const text = [
      "/workspace/../../etc/passwd.txt",
      "/workspace/sub/../../secret.env",
      "/workspace/ok.txt",
    ].join("\n");
    expect(extractWorkspacePaths(text)).toEqual(["ok.txt"]);
  });

  it("drops bare-dot segments too", () => {
    expect(extractWorkspacePaths("/workspace/./hidden.txt")).toEqual([]);
  });
});
