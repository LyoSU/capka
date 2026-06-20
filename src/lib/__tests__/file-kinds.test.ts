import { describe, it, expect } from "vitest";
import { previewKind, fileKind, extOf } from "../file-kinds";

describe("extOf", () => {
  it("lowercases the extension and drops the dot", () => {
    expect(extOf("Photo.PNG")).toBe("png");
    expect(extOf("archive.tar.gz")).toBe("gz");
  });
  it("returns empty string when there's no extension", () => {
    expect(extOf("Dockerfile")).toBe("");
  });
});

describe("previewKind", () => {
  it("treats images as image (including MIME-only formats)", () => {
    for (const n of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.avif", "a.heic"])
      expect(previewKind(n)).toBe("image");
  });

  it("treats PDFs as pdf", () => {
    expect(previewKind("report.pdf")).toBe("pdf");
  });

  it("treats markdown as markdown", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("notes.markdown")).toBe("markdown");
  });

  it("treats code and plain text as text", () => {
    for (const n of ["a.txt", "a.log", "a.csv", "a.json", "a.yaml", "a.toml", "a.py", "a.go", "a.rs", "a.css", "a.sh"])
      expect(previewKind(n)).toBe("text");
  });

  it("keeps dev extensions text even when MIME mislabels them (.ts → video/mp2t)", () => {
    expect(previewKind("app.ts")).toBe("text");
    expect(previewKind("App.tsx")).toBe("text");
    expect(previewKind("Component.vue")).toBe("text");
  });

  it("returns null for real binaries, video and audio", () => {
    for (const n of ["a.docx", "a.xlsx", "a.zip", "a.mp4", "a.mp3", "a.bin"])
      expect(previewKind(n)).toBeNull();
  });
});

describe("fileKind", () => {
  it("flags directories as folders", () => {
    expect(fileKind("src", true).label).toBe("Folder");
  });
  it("broadens icons via MIME for unlisted types", () => {
    expect(fileKind("clip.mp4").label).toBe("Video");
    expect(fileKind("song.mp3").label).toBe("Audio");
    expect(fileKind("bundle.zip").label).toBe("Archive");
  });
  it("falls back to the uppercased extension for unknown types", () => {
    expect(fileKind("data.xyz").label).toBe("XYZ");
  });
});
