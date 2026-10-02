import { describe, expect, it } from "vitest";
import { composerSlot } from "@/components/chat/composer-slot";

const idle = { hasContent: false, hasStaged: false, isRunning: false, isDictating: false, dictationSupported: true };

describe("composerSlot", () => {
  it("offers the microphone when there is nothing to send", () => {
    expect(composerSlot(idle)).toBe("mic");
  });
  it("swaps to send once there is text or a ready file", () => {
    expect(composerSlot({ ...idle, hasContent: true })).toBe("send");
  });
  it("shows send for a staged file that is still uploading", () => {
    expect(composerSlot({ ...idle, hasStaged: true })).toBe("send");
  });
  it("keeps the dictation stop even when interim text fills the box", () => {
    expect(composerSlot({ ...idle, isDictating: true, hasContent: true })).toBe("dictate-stop");
    expect(composerSlot({ ...idle, isDictating: true, isRunning: true })).toBe("dictate-stop");
  });
  it("keeps Stop for an empty box during a reply, send (queue) with text", () => {
    expect(composerSlot({ ...idle, isRunning: true })).toBe("stop");
    expect(composerSlot({ ...idle, isRunning: true, hasContent: true })).toBe("send");
  });
  it("falls back to the disabled send without a speech engine", () => {
    expect(composerSlot({ ...idle, dictationSupported: false })).toBe("send");
  });
  it("shows send while a card awaits the user", () => {
    expect(composerSlot({ ...idle, awaitingInput: true })).toBe("send");
  });
});
