import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A markdown image in an answer has a place before it has pixels.
 *
 * An unsized <img> is zero height until it decodes, then shoves everything below
 * it by its full height — the one layout shift the scroll engine has to absorb on
 * every image in every reply. The image now renders into a reserved box that
 * pulses while loading, fades in once decoded, and on failure becomes a quiet
 * labelled chip instead of vanishing (Streamdown's default hides a broken image,
 * which leaves a sentence pointing at nothing).
 */
const IMAGE = "src/components/chat/chat-image.tsx";
const PATHS = "src/components/chat/workspace-path.tsx";

describe("chat image", () => {
  const image = readFileSync(IMAGE, "utf8");
  const paths = readFileSync(PATHS, "utf8");

  it("is what the markdown renderer uses for <img>", () => {
    expect(paths).toMatch(/img\([^)]*\)\s*\{[^}]*<ChatImage/);
  });

  it("reserves a box while loading and fades the picture in once decoded", () => {
    expect(image).toMatch(/aspect-\[3\/2\]/);
    expect(image).toMatch(/animate-pulse/);
    expect(image).toMatch(/onLoad=/);
    expect(image).toMatch(/transition-opacity/);
    // A cached image can be complete before the load handler is attached.
    expect(image).toMatch(/\.complete/);
  });

  it("a broken image becomes a labelled chip, never nothing", () => {
    expect(image).toMatch(/onError=/);
    expect(image).toMatch(/t\("imageUnavailable"\)/);
    for (const locale of ["en", "uk"]) {
      const catalog = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
      expect(catalog.chat.message.imageUnavailable, locale).toBeTypeOf("string");
    }
  });
});
