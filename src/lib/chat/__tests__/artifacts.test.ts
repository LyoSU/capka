import { describe, it, expect } from "vitest";
import { extractWorkspacePaths, workspaceRelFromHref } from "../artifacts";

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

describe("workspaceRelFromHref", () => {
  it("decodes percent-encoded (Cyrillic) names so the chip reads correctly", () => {
    const href = "/workspace/" + encodeURIComponent("KNESS_аудит продукту.docx");
    expect(workspaceRelFromHref(href)).toBe("KNESS_аудит продукту.docx");
  });

  it("returns a plain relative path unchanged", () => {
    expect(workspaceRelFromHref("/workspace/sub/report.pdf")).toBe("sub/report.pdf");
  });

  it("rejects non-workspace hrefs", () => {
    expect(workspaceRelFromHref("https://example.com/x")).toBeNull();
    expect(workspaceRelFromHref("/etc/passwd")).toBeNull();
  });

  it("rejects traversal even when the dots are percent-encoded", () => {
    expect(workspaceRelFromHref("/workspace/%2e%2e/%2e%2e/etc/passwd.txt")).toBeNull();
  });

  it("rejects malformed percent-encoding rather than guessing", () => {
    expect(workspaceRelFromHref("/workspace/50%.pdf")).toBeNull();
  });
});
