import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DICTATION_MAX_MS,
  appendPhrase,
  composeDictation,
  createDictationEngine,
  isDictationSupported,
  speechLangFor,
  type DictationErrorKind,
  type SpeechRecognitionLike,
  type SpeechResultEventLike,
  type SpeechResultLike,
} from "../use-dictation";

/**
 * A stand-in for the browser's speech engine. It implements only what the
 * dictation engine touches, and exposes `say`/`end`/`fail` so a test can play the
 * part of someone talking — including the mid-sentence revisions and the
 * silence-triggered restarts a real engine does on its own.
 */
class FakeRecognition implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  started = false;
  aborted = false;
  onresult: ((event: SpeechResultEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;

  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.started = false;
  }

  /** Deliver the whole result list for this run, as the real event carries it. */
  say(...phrases: { text: string; final?: boolean }[]) {
    const results: SpeechResultLike[] = phrases.map((p) =>
      Object.assign([{ transcript: p.text }], { isFinal: Boolean(p.final) }),
    );
    this.onresult?.({ results });
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
  /** The engine closing the run by itself, as Chrome does after a pause. */
  end() {
    this.started = false;
    this.onend?.();
  }
}

/**
 * A composer that isn't React: it holds a value and a selection, and lets a test
 * type into it the way a user would. Everything the engine promises is
 * observable from here.
 */
function harness(initial = "", caret = initial.length) {
  let value = initial;
  let selection = { start: caret, end: caret };
  const made: FakeRecognition[] = [];
  const errors: DictationErrorKind[] = [];

  const engine = createDictationEngine({
    getValue: () => value,
    getSelection: () => selection,
    emit: (next, start, end) => {
      value = next;
      selection = { start, end };
    },
    changed: () => {},
    failed: (kind) => errors.push(kind),
    lang: () => "en-US",
    create: () => {
      const r = new FakeRecognition();
      made.push(r);
      return r;
    },
  });

  return {
    engine,
    errors,
    value: () => value,
    selection: () => selection,
    /** The run currently wired up. */
    live: () => made[made.length - 1],
    runs: () => made.length,
    /** What a keystroke does: change the text, then tell the engine about it. */
    type(next: string, at = next.length) {
      value = next;
      selection = { start: at, end: at };
      engine.syncValue(next);
    },
    /** Drag-select a range, as a user does before speaking over it. */
    select(start: number, end: number) {
      selection = { start, end };
    },
  };
}

describe("speechLangFor", () => {
  it("gives the shipped locales a region the engines recognise", () => {
    expect(speechLangFor("uk")).toBe("uk-UA");
    expect(speechLangFor("en")).toBe("en-US");
  });

  it("passes an unknown locale through rather than inventing a region", () => {
    // "zh-ZH" is not a thing; a bare "zh" is, and every engine resolves it.
    expect(speechLangFor("zh")).toBe("zh");
    expect(speechLangFor("pt-BR")).toBe("pt-BR");
  });
});

describe("appendPhrase", () => {
  it("joins phrases with exactly one space however the engine padded them", () => {
    expect(appendPhrase("hello", "  there ")).toBe("hello there");
    expect(appendPhrase("", " first")).toBe("first");
    expect(appendPhrase("kept", "   ")).toBe("kept");
  });
});

describe("composeDictation", () => {
  it("does not glue speech onto the word the caret sits behind", () => {
    expect(composeDictation("Hello", "there", "!")).toEqual({ value: "Hello there!", caret: 11 });
  });

  it("leaves an existing space alone instead of doubling it", () => {
    expect(composeDictation("Hello ", "there", "")).toEqual({ value: "Hello there", caret: 11 });
  });
});

describe("isDictationSupported", () => {
  afterEach(() => {
    delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
    delete (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });

  it("is false where the browser has no speech engine, so no button is rendered", () => {
    expect(isDictationSupported()).toBe(false);
  });

  it("accepts the prefixed constructor Safari and Chrome still ship", () => {
    (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    expect(isDictationSupported()).toBe(true);
  });
});

describe("dictation engine", () => {
  it("inserts at the caret, replacing the interim guess when the phrase firms up", () => {
    const h = harness("Hello world", 5); // caret right after "Hello"
    h.engine.start();
    expect(h.engine.listening()).toBe(true);
    expect(h.live().continuous).toBe(true);
    expect(h.live().interimResults).toBe(true);

    h.live().say({ text: "there" });
    expect(h.value()).toBe("Hello there world");
    // Caret parks after the dictated text, not at the end of the box.
    expect(h.selection()).toEqual({ start: 11, end: 11 });

    // The engine revises what it heard; the interim text is replaced, not appended.
    h.live().say({ text: "there you are", final: true });
    expect(h.value()).toBe("Hello there you are world");
    expect(h.selection()).toEqual({ start: 19, end: 19 });
  });

  it("replaces a selection, the way typing over one does", () => {
    const h = harness("keep THIS text");
    h.select(5, 9); // "THIS"
    h.engine.start();
    h.live().say({ text: "that", final: true });
    expect(h.value()).toBe("keep that text");
  });

  it("carries finished text across the restarts the engine does on silence", () => {
    const h = harness("");
    h.engine.start();
    h.live().say({ text: "first sentence", final: true });
    expect(h.value()).toBe("first sentence");

    // Chrome closes the run after a pause; we reopen it and the user never knows.
    h.live().end();
    expect(h.runs()).toBe(2);
    expect(h.engine.listening()).toBe(true);

    h.live().say({ text: "second sentence", final: true });
    expect(h.value()).toBe("first sentence second sentence");
  });

  it("undoes the whole dictation back to the text and caret it started from", () => {
    const h = harness("Draft note", 5);
    h.engine.start();
    h.live().say({ text: "one two three", final: true });
    expect(h.value()).toBe("Draft one two three note");

    h.engine.stop();
    expect(h.engine.listening()).toBe(false);
    expect(h.engine.canUndo()).toBe(true);

    h.engine.undo();
    expect(h.value()).toBe("Draft note");
    expect(h.selection()).toEqual({ start: 5, end: 5 });
    expect(h.engine.canUndo()).toBe(false);
  });

  it("stands the undo down once the user has typed over the result", () => {
    const h = harness("");
    h.engine.start();
    h.live().say({ text: "spoken words", final: true });
    h.engine.stop();
    expect(h.engine.canUndo()).toBe(true);

    // From here an undo would throw the user's own edit away too.
    h.type("spoken words, and mine");
    expect(h.engine.canUndo()).toBe(false);
    h.engine.undo();
    expect(h.value()).toBe("spoken words, and mine");
  });

  it("reports a refused microphone so the composer can say so, and stops", () => {
    const h = harness("");
    h.engine.start();
    h.live().fail("not-allowed");
    h.live().end();
    expect(h.errors).toEqual(["permission"]);
    expect(h.engine.listening()).toBe(false);
    // No restart: a refusal is not a pause.
    expect(h.runs()).toBe(1);
  });

  it("ends a silent session without saying anything", () => {
    const h = harness("");
    h.engine.start();
    h.live().fail("no-speech");
    h.live().end();
    expect(h.errors).toEqual([]);
    expect(h.engine.listening()).toBe(false);
  });

  // Every handler has to come off the abandoned run, not just the three that
  // deliver text: an audiostart arriving after the abort would put the phase back
  // to "hearing" for a session that is over (and update state after unmount).
  it("detaches every handler from the run it abandons", () => {
    for (const leave of [(h: ReturnType<typeof harness>) => h.engine.stop(), (h) => h.engine.dispose()] as ((h: ReturnType<typeof harness>) => void)[]) {
      const h = harness("");
      h.engine.start();
      const r = h.live();
      r.onaudiostart?.();
      expect(h.engine.phase()).toBe("hearing");
      leave(h);
      expect(r.aborted).toBe(true);
      expect([r.onresult, r.onerror, r.onend, r.onaudiostart]).toEqual([null, null, null, null]);
    }
  });
});

describe("the ten-minute cap", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes the microphone even if nobody remembers it is open", () => {
    const h = harness("");
    h.engine.start();
    h.live().say({ text: "still talking", final: true });

    vi.advanceTimersByTime(DICTATION_MAX_MS - 1);
    expect(h.engine.listening()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(h.engine.listening()).toBe(false);
    // The words spoken before the cap are kept; only the microphone closes.
    expect(h.value()).toBe("still talking");
    expect(h.engine.canUndo()).toBe(true);
  });

  it("counts the cap from the first start, not from each silent restart", () => {
    const h = harness("");
    h.engine.start();
    vi.advanceTimersByTime(DICTATION_MAX_MS / 2);
    h.live().say({ text: "one", final: true });
    h.live().end(); // reopened transparently
    expect(h.engine.listening()).toBe(true);

    vi.advanceTimersByTime(DICTATION_MAX_MS / 2);
    expect(h.engine.listening()).toBe(false);
  });
});
