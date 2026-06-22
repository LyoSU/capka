import { describe, it, expect } from "vitest";
import { classifyFiles } from "../prompt";
import { providerAcceptsNativeFile } from "@/lib/providers/registry";
import type { FileRef } from "@/lib/constants";

const file = (type: string): FileRef => ({ name: `f.${type.split("/")[1]}`, type, size: 1 } as FileRef);

describe("providerAcceptsNativeFile", () => {
  it("accepts images on every provider (image_url is near-universal)", () => {
    for (const p of ["litellm", "openrouter", "openai", "anthropic", "ollama"]) {
      expect(providerAcceptsNativeFile(p, "image/png")).toBe(true);
    }
  });

  it("accepts inline PDF only on first-party APIs and the OpenRouter gateway", () => {
    expect(providerAcceptsNativeFile("anthropic", "application/pdf")).toBe(true);
    expect(providerAcceptsNativeFile("openai", "application/pdf")).toBe(true);
    expect(providerAcceptsNativeFile("openrouter", "application/pdf")).toBe(true);
  });

  it("rejects inline PDF on generic OpenAI-compatible endpoints (Z.ai) and Ollama", () => {
    // The root cause of the `messages[N].content[1].type` error: a synthetic
    // `{type:"file"}` block these endpoints don't accept.
    expect(providerAcceptsNativeFile("litellm", "application/pdf")).toBe(false);
    expect(providerAcceptsNativeFile("ollama", "application/pdf")).toBe(false);
  });

  it("rejects non-multimodal types everywhere", () => {
    expect(providerAcceptsNativeFile("openai", "text/csv")).toBe(false);
    expect(providerAcceptsNativeFile("anthropic", "application/zip")).toBe(false);
  });
});

describe("classifyFiles (provider-aware)", () => {
  it("keeps a PDF native for Anthropic", () => {
    const { nativeFiles, hasToolOnly } = classifyFiles([file("application/pdf")], "anthropic");
    expect(nativeFiles).toHaveLength(1);
    expect(hasToolOnly).toBe(false);
  });

  it("degrades a PDF to tool-only for Z.ai (openai-compatible)", () => {
    const { nativeFiles, hasToolOnly } = classifyFiles([file("application/pdf")], "litellm");
    expect(nativeFiles).toHaveLength(0);
    expect(hasToolOnly).toBe(true);
  });

  it("still sends an image natively to Z.ai", () => {
    const { nativeFiles, hasToolOnly } = classifyFiles([file("image/jpeg")], "litellm");
    expect(nativeFiles).toHaveLength(1);
    expect(hasToolOnly).toBe(false);
  });
});
