import { describe, it, expect } from "vitest";
import {
  extractWorkspacePaths,
  workspaceRelFromHref,
  freshWorkspacePathRe,
  SAFE_WORKSPACE_PATH_RE,
} from "../artifacts";

describe("extractWorkspacePaths", () => {
  it("captures file names in any script, not just Latin and Cyrillic", () => {
    const text = "写好了 /workspace/季度报告.docx，另见 /workspace/υπολογισμός.xlsx";
    expect(extractWorkspacePaths(text)).toEqual(["季度报告.docx", "υπολογισμός.xlsx"]);
  });

  it("captures a non-Latin name inside a nested directory", () => {
    expect(extractWorkspacePaths("см. /workspace/合同/审核 意见.pdf")).toEqual(["合同/审核 意见.pdf"]);
  });

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

describe("freshWorkspacePathRe", () => {
  it("returns an independent matcher, so one caller's scan can't skip another's", () => {
    const a = freshWorkspacePathRe();
    expect(a.exec("/workspace/a.txt")).not.toBeNull();
    // A shared global regex would resume from lastIndex here and miss the match.
    expect(freshWorkspacePathRe().exec("/workspace/a.txt")).not.toBeNull();
  });

  it("keeps the unicode flag, so a clone still matches non-Latin names", () => {
    expect(freshWorkspacePathRe().exec("/workspace/报告.pdf")?.[1]).toBe("报告.pdf");
  });
});

describe("SAFE_WORKSPACE_PATH_RE", () => {
  it("accepts a non-Latin workspace-relative path", () => {
    expect(SAFE_WORKSPACE_PATH_RE.test("合同/审核 意见.pdf")).toBe(true);
    expect(SAFE_WORKSPACE_PATH_RE.test("звіт (1).xlsx")).toBe(true);
  });

  it("rejects shell metacharacters that must never reach the archive command", () => {
    for (const bad of ["a;rm -rf /", "a'b.txt", "a$(id).txt", "a`id`.txt", "a|b.txt", "a\nb.txt", "a&b.txt"]) {
      expect(SAFE_WORKSPACE_PATH_RE.test(bad)).toBe(false);
    }
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
