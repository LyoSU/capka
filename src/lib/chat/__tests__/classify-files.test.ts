import { describe, it, expect } from "vitest";
import { classifyFiles } from "../prompt";
import { acceptsNativeFile, mimeToModality } from "@/lib/providers/registry";
import type { FileRef } from "@/lib/constants";

const file = (type: string): FileRef => ({ name: `f.${type.split("/")[1]}`, type, size: 1 } as FileRef);

describe("mimeToModality", () => {
  it("maps MIME prefixes to modalities", () => {
    expect(mimeToModality("image/png")).toBe("image");
    expect(mimeToModality("application/pdf")).toBe("pdf");
    expect(mimeToModality("audio/mpeg")).toBe("audio");
    expect(mimeToModality("video/mp4")).toBe("video");
    expect(mimeToModality("text/csv")).toBeNull();
  });
});

describe("acceptsNativeFile (provider fallback caps)", () => {
  it("accepts images on every provider (image_url is near-universal)", () => {
    for (const p of ["litellm", "openrouter", "openai", "anthropic", "google", "ollama"]) {
      expect(acceptsNativeFile("image/png", p)).toBe(true);
    }
  });

  it("accepts inline PDF on the first-party APIs and the OpenRouter gateway", () => {
    expect(acceptsNativeFile("application/pdf", "anthropic")).toBe(true);
    expect(acceptsNativeFile("application/pdf", "openai")).toBe(true);
    expect(acceptsNativeFile("application/pdf", "openrouter")).toBe(true);
    expect(acceptsNativeFile("application/pdf", "google")).toBe(true);
  });

  it("rejects inline PDF on generic OpenAI-compatible endpoints (Z.ai) and Ollama", () => {
    // The root cause of the `messages[N].content[1].type` error: a synthetic
    // `{type:"file"}` block these endpoints don't accept.
    expect(acceptsNativeFile("application/pdf", "litellm")).toBe(false);
    expect(acceptsNativeFile("application/pdf", "ollama")).toBe(false);
  });

  it("accepts audio via static caps only on Gemini (all multimodal); elsewhere it needs per-model data", () => {
    // Gemini's whole family takes audio, so the static fallback allows it.
    expect(acceptsNativeFile("audio/mpeg", "google")).toBe(true);
    // openai/openrouter are model-specific for audio + have no audio-unsupported
    // retry, so the static fallback withholds it (per-model data re-enables it).
    expect(acceptsNativeFile("audio/mpeg", "openai")).toBe(false);
    expect(acceptsNativeFile("audio/mpeg", "openrouter")).toBe(false);
    expect(acceptsNativeFile("audio/mpeg", "anthropic")).toBe(false);
  });

  it("accepts video ONLY on Google (the only SDK that emits it)", () => {
    expect(acceptsNativeFile("video/mp4", "google")).toBe(true);
    expect(acceptsNativeFile("video/mp4", "openrouter")).toBe(false);
    expect(acceptsNativeFile("video/mp4", "openai")).toBe(false);
    expect(acceptsNativeFile("video/mp4", "anthropic")).toBe(false);
  });

  it("rejects non-multimodal types everywhere", () => {
    expect(acceptsNativeFile("text/csv", "openai")).toBe(false);
    expect(acceptsNativeFile("application/zip", "anthropic")).toBe(false);
  });
});

describe("acceptsNativeFile (per-model modalities win)", () => {
  it("uses the model's input_modalities over the provider fallback", () => {
    // An OpenRouter model that lists audio takes audio…
    expect(acceptsNativeFile("audio/mpeg", "openrouter", ["image", "audio"])).toBe(true);
    // …and one that lists only image/pdf degrades audio to tool-only.
    expect(acceptsNativeFile("audio/mpeg", "openrouter", ["image", "pdf"])).toBe(false);
    expect(acceptsNativeFile("application/pdf", "openrouter", ["image", "pdf"])).toBe(true);
  });

  it("never makes video native off Google, even if the catalog claims it", () => {
    expect(acceptsNativeFile("video/mp4", "openrouter", ["image", "video"])).toBe(false);
  });

  it("always keeps PDF native on OpenRouter, even when the model omits 'file'", () => {
    // OpenRouter parses PDFs server-side for any model; input_modalities often
    // lack 'file' even for PDF-capable models, so per-model must not gate it.
    expect(acceptsNativeFile("application/pdf", "openrouter", ["image"])).toBe(true);
    expect(acceptsNativeFile("application/pdf", "openrouter", [])).toBe(true);
  });
});

describe("classifyFiles (provider + per-model aware)", () => {
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

  it("sends video natively to Gemini, tool-only elsewhere", () => {
    expect(classifyFiles([file("video/mp4")], "google").nativeFiles).toHaveLength(1);
    expect(classifyFiles([file("video/mp4")], "openrouter").nativeFiles).toHaveLength(0);
  });

  it("respects a model's per-model modalities", () => {
    const { nativeFiles } = classifyFiles([file("audio/mpeg")], "openrouter", ["image", "audio"]);
    expect(nativeFiles).toHaveLength(1);
  });
});
