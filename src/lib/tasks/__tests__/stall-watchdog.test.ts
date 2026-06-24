import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StallWatchdog } from "../stall-watchdog";

// The watchdog is a phase-aware idle timer: it fires `onStall` when the provider
// goes silent for `idleMs` WHILE we're waiting for model output — but never while
// a local tool is executing (that quiet gap is us, not a hung provider).
describe("StallWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onStall after idleMs of silence once started", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("does not fire when activity keeps arriving inside the window", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    vi.advanceTimersByTime(800);
    wd.activity(); // a chunk arrived — provider is alive, reset the timer
    vi.advanceTimersByTime(800);
    wd.activity();
    vi.advanceTimersByTime(800);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("does NOT fire while a tool is executing, even past idleMs", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    wd.enterTool(); // local tool began — the quiet that follows is us running it
    vi.advanceTimersByTime(5000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("re-arms after the tool finishes and fires on subsequent silence", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    wd.enterTool();
    vi.advanceTimersByTime(5000);
    wd.exitTool(); // back to waiting for the model's next step
    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("stays paused until ALL in-flight tools finish (parallel tools)", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    wd.enterTool();
    wd.enterTool();
    wd.exitTool(); // one done, one still running — must stay paused
    vi.advanceTimersByTime(5000);
    expect(onStall).not.toHaveBeenCalled();
    wd.exitTool(); // all done — re-armed
    vi.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("fires at most once per armed period", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    vi.advanceTimersByTime(3000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("stop() prevents any further firing", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    wd.stop();
    vi.advanceTimersByTime(5000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("can be restarted for a fresh attempt after firing", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(1000, onStall);
    wd.start();
    vi.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(1);
    wd.start(); // a retry re-streams — watch the new attempt
    vi.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(2);
  });
});
