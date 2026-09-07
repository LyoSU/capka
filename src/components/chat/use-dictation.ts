"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Voice dictation for the composer, on the browser's own Web Speech API — no
 * server, no dependency, no upload of our own.
 *
 * The file is split in two on purpose. Everything that decides *what the text
 * becomes* lives in a plain, framework-free engine below; `useDictation` is a
 * thin React wrapper that only owns refs, state and the caret write-back. The
 * suite drives the engine directly with a fake recognition class, which is why
 * none of the rules here need a DOM to be tested.
 */

/**
 * Hard stop for one dictation session, counted from the first `start()` and
 * across the transparent restarts below. A microphone left open by accident is
 * the failure mode we care about — ten minutes is far past any real dictation
 * and short enough that a forgotten tab isn't listening all afternoon.
 */
export const DICTATION_MAX_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * The slice of the Web Speech API we actually touch.
 * Typing it ourselves (rather than leaning on lib.dom) keeps the engine
 * substitutable: the suite passes a fake that satisfies exactly this.
 * ------------------------------------------------------------------ */

export interface SpeechAlternativeLike {
  transcript: string;
}

export interface SpeechResultLike extends ArrayLike<SpeechAlternativeLike> {
  /** False while the engine is still revising this phrase. */
  isFinal: boolean;
}

export interface SpeechResultEventLike {
  /** Every result of the CURRENT recognition run, finalised or not. */
  results: ArrayLike<SpeechResultLike>;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** What the UI has to say out loud when dictation gives up. */
export type DictationErrorKind = "permission" | "failed";

/**
 * The vendor-prefixed constructor, read off `globalThis` rather than `window`:
 * they are the same object in a browser, and this way the engine is reachable
 * from a plain Node test that assigns a fake.
 */
export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const g = globalThis as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/** Whether this browser can dictate at all. When false the button never renders. */
export function isDictationSupported(): boolean {
  return speechRecognitionCtor() !== null;
}

/**
 * Our UI locale is a bare language tag; the speech engines want a BCP-47 region
 * tag and pick a poor default without one. Only the locales we ship are mapped —
 * for anything else the raw locale is a better guess than an invented region
 * (`zh` is `zh-CN`, never `zh-ZH`), and every engine resolves a bare tag itself.
 */
export function speechLangFor(locale: string): string {
  const base = locale.toLowerCase().split(/[-_]/)[0];
  if (base === "uk") return "uk-UA";
  if (base === "en") return locale.includes("-") ? locale : "en-US";
  return locale;
}

/**
 * Append one recognised phrase to what we already have. Trimming each phrase
 * before joining is what keeps a single space between them however the engine
 * pads its own output — the doubled spaces come from the engine, not from us.
 */
export function appendPhrase(acc: string, phrase: string): string {
  const piece = phrase.trim();
  if (!piece) return acc;
  return acc ? `${acc} ${piece}` : piece;
}

/**
 * Put the dictated text into the composer at the caret, and say where the caret
 * lands afterwards. A leading space is added when the caret sits tight against a
 * word, so speaking mid-sentence doesn't glue the new words onto the old one.
 */
export function composeDictation(
  before: string,
  dictated: string,
  after: string,
): { value: string; caret: number } {
  if (!dictated) return { value: before + after, caret: before.length };
  const lead = before && !/\s$/.test(before) ? " " : "";
  const head = before + lead + dictated;
  return { value: head + after, caret: head.length };
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

export interface DictationHost {
  /** The composer's current text. */
  getValue(): string;
  /** The composer's caret, or the range a dictation would replace. */
  getSelection(): { start: number; end: number };
  /** Write text back into the composer and park the selection. */
  emit(value: string, start: number, end: number): void;
  /** `listening` or `canUndo` moved; re-render. */
  changed(): void;
  /** Dictation gave up in a way the user has to be told about. */
  failed(kind: DictationErrorKind): void;
  /** BCP-47 tag for the recognition run, read fresh at every start. */
  lang(): string;
  /** Injection point for the suite; defaults to the browser's constructor. */
  create?(): SpeechRecognitionLike;
}

export interface DictationEngine {
  listening(): boolean;
  canUndo(): boolean;
  start(): void;
  stop(): void;
  undo(): void;
  /** The composer's value changed; decide whether it was us or the user. */
  syncValue(value: string): void;
  /** Tear down for good — the composer is unmounting. */
  dispose(): void;
}

export function createDictationEngine(host: DictationHost): DictationEngine {
  /** Text left of the caret when this dictation started, and text right of it. */
  let before = "";
  let after = "";
  /** Finalised phrases from recognition runs that have already ended. */
  let carried = "";
  /** Finalised phrases from the run in progress. */
  let settled = "";
  /** The phrase the engine is still revising. Replaced wholesale each event. */
  let draft = "";

  /** The composer exactly as it was before this dictation. `null` → nothing to undo. */
  let snapshot: { value: string; start: number; end: number } | null = null;
  /** The last text WE wrote, so a value that isn't this one came from the user. */
  let written: string | null = null;

  let recognition: SpeechRecognitionLike | null = null;
  /** The user wants to be listening. Survives the restarts an engine does on its own. */
  let wanted = false;
  /** Set when the run ended for a reason that must not be restarted through. */
  let terminal = false;
  /** Runs reopened in a row that heard nothing. Guards against a restart storm. */
  let barren = 0;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const listening = () => wanted;
  const canUndo = () => snapshot !== null;

  const dictated = () => appendPhrase(carried, appendPhrase(settled, draft));

  /** Re-render the composer from the current speech state. */
  const paint = () => {
    const { value, caret } = composeDictation(before, dictated(), after);
    // Bookkeeping often lands on the text we already wrote (ending a run just
    // moves phrases between two buckets). Staying quiet keeps a redundant
    // `onChange` out of the composer's state on the way to submit.
    if (value === written) return;
    written = value;
    host.emit(value, caret, caret);
  };

  /** Split the composer at the caret. A selected range is what dictation replaces. */
  const baseline = () => {
    const value = host.getValue();
    const { start, end } = host.getSelection();
    snapshot = { value, start, end };
    before = value.slice(0, start);
    after = value.slice(end);
    carried = "";
    settled = "";
    draft = "";
  };

  const clearCap = () => {
    if (capTimer !== null) clearTimeout(capTimer);
    capTimer = null;
  };

  /** Detach and silence the current recognition object. */
  const release = () => {
    const r = recognition;
    recognition = null;
    if (!r) return;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try {
      r.abort();
    } catch {
      // Already dead, or never really started — nothing left to stop.
    }
  };

  /** Build and arm one recognition run. Returns false if the engine refused. */
  const run = (): boolean => {
    const r = host.create ? host.create() : new (speechRecognitionCtor()!)();
    r.lang = host.lang();
    r.continuous = true;
    r.interimResults = true;
    let heard = false;

    r.onresult = (event) => {
      heard = true;
      barren = 0;
      // Recompute the whole run from its results rather than tracking deltas:
      // the engine revises earlier phrases as it hears more, and `results` is
      // always the authoritative list for the run in progress.
      let finals = "";
      let interim = "";
      const list = event.results;
      for (let i = 0; i < list.length; i++) {
        const result = list[i];
        const text = result?.[0]?.transcript ?? "";
        if (result?.isFinal) finals = appendPhrase(finals, text);
        else interim = appendPhrase(interim, text);
      }
      settled = finals;
      draft = interim;
      paint();
    };

    r.onerror = (event) => {
      const code = event?.error;
      if (code === "aborted") return; // Our own `stop()` on the way out.
      terminal = true;
      if (code === "not-allowed" || code === "service-not-allowed") {
        host.failed("permission");
      } else if (code !== "no-speech") {
        // Silence is not a failure worth a message — it just ends the session.
        host.failed("failed");
      }
    };

    r.onend = () => {
      // Chrome ends a run of its own accord after a pause, well before the user
      // is done talking. Carry the finalised text over and open the next run so
      // the session looks continuous — unless something told us to stop.
      // Fold the revision-in-progress in too, not just the finalised phrases: a
      // run that ends without finalising its last words would otherwise drop the
      // sentence the user just spoke.
      carried = appendPhrase(carried, appendPhrase(settled, draft));
      settled = "";
      draft = "";
      // A run that heard nothing and ended immediately would otherwise reopen
      // forever; three in a row means the engine is refusing, not pausing.
      barren = heard ? 0 : barren + 1;
      if (!wanted || terminal || disposed || barren > 3) {
        finish();
        return;
      }
      recognition = null;
      if (!run()) finish();
    };

    recognition = r;
    try {
      r.start();
      return true;
    } catch {
      release();
      return false;
    }
  };

  /** Leave the listening state, keeping whatever was dictated (and the undo). */
  const finish = () => {
    const was = wanted;
    wanted = false;
    terminal = false;
    clearCap();
    release();
    paint();
    if (was) host.changed();
  };

  const start = () => {
    if (disposed || wanted) return;
    if (!host.create && !speechRecognitionCtor()) return;
    baseline();
    wanted = true;
    terminal = false;
    barren = 0;
    if (!run()) {
      wanted = false;
      snapshot = null;
      host.failed("failed");
      host.changed();
      return;
    }
    clearCap();
    capTimer = setTimeout(() => {
      capTimer = null;
      if (wanted) finish();
    }, DICTATION_MAX_MS);
    host.changed();
  };

  const stop = () => {
    if (!wanted) return;
    wanted = false;
    terminal = true;
    clearCap();
    release();
    paint();
    host.changed();
  };

  const undo = () => {
    const restore = snapshot;
    if (!restore) return;
    if (wanted) {
      wanted = false;
      terminal = true;
      clearCap();
      release();
    }
    snapshot = null;
    before = "";
    after = "";
    carried = "";
    settled = "";
    draft = "";
    written = restore.value;
    host.emit(restore.value, restore.start, restore.end);
    host.changed();
  };

  const syncValue = (value: string) => {
    if (disposed || written === null || value === written) return;
    // The composer holds something we did not write: the user typed, or the
    // message was sent. Either way the undo no longer means anything.
    written = null;
    snapshot = null;
    if (wanted) {
      // Still listening — re-aim at wherever the caret is now, so the next
      // phrase lands where the user is looking instead of at a stale offset.
      // The undo stays gone: it promised the text as it was before dictation,
      // and the user has since written something it would throw away.
      const { start, end } = host.getSelection();
      before = value.slice(0, start);
      after = value.slice(end);
      carried = "";
      settled = "";
      draft = "";
      written = value;
    }
    host.changed();
  };

  const dispose = () => {
    disposed = true;
    wanted = false;
    clearCap();
    release();
  };

  return { listening, canUndo, start, stop, undo, syncValue, dispose };
}

/* ------------------------------------------------------------------ *
 * The React wrapper
 * ------------------------------------------------------------------ */

export interface UseDictationOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** UI locale, e.g. `uk`. Mapped to a speech tag by `speechLangFor`. */
  lang: string;
  /** Told which message to show; the composer owns the translations. */
  onError?: (kind: DictationErrorKind) => void;
}

export interface UseDictationResult {
  supported: boolean;
  listening: boolean;
  canUndo: boolean;
  start: () => void;
  stop: () => void;
  undo: () => void;
  toggle: () => void;
}

export function useDictation({
  textareaRef,
  value,
  onChange,
  lang,
  onError,
}: UseDictationOptions): UseDictationResult {
  // Resolved in an effect, not at render: the server has no speech engine, so
  // reading it during render would render a button the client then removes.
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState({ listening: false, canUndo: false });

  // Everything the engine reads back out of React, kept fresh without making the
  // engine itself depend on a render.
  const latest = useRef({ value, onChange, lang, onError, textareaRef });
  useEffect(() => {
    latest.current = { value, onChange, lang, onError, textareaRef };
  });

  /** A selection to apply once the controlled textarea has rendered the new value. */
  const pending = useRef<{ start: number; end: number } | null>(null);
  const engineRef = useRef<DictationEngine | null>(null);

  if (engineRef.current === null) {
    engineRef.current = createDictationEngine({
      getValue: () => latest.current.value,
      getSelection: () => {
        const el = latest.current.textareaRef.current;
        if (!el) {
          const end = latest.current.value.length;
          return { start: end, end };
        }
        return { start: el.selectionStart, end: el.selectionEnd };
      },
      emit: (next, start, end) => {
        pending.current = { start, end };
        latest.current.onChange(next);
      },
      changed: () => {
        const engine = engineRef.current!;
        setState({ listening: engine.listening(), canUndo: engine.canUndo() });
      },
      failed: (kind) => latest.current.onError?.(kind),
      lang: () => speechLangFor(latest.current.lang),
    });
  }
  const engine = engineRef.current;

  useEffect(() => {
    setSupported(isDictationSupported());
  }, []);

  // Park the caret after the text we just inserted. This runs after React has
  // written `value` onto the controlled textarea, which is the only moment the
  // offsets are meaningful.
  useEffect(() => {
    const want = pending.current;
    if (!want) return;
    pending.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.setSelectionRange(want.start, want.end);
  }, [value, textareaRef]);

  // Tell the engine when the composer changed under it — a keystroke, or the
  // parent clearing the box on send.
  useEffect(() => {
    engine.syncValue(value);
  }, [engine, value]);

  useEffect(() => () => engine.dispose(), [engine]);

  const start = useCallback(() => {
    textareaRef.current?.focus();
    engine.start();
  }, [engine, textareaRef]);

  const stop = useCallback(() => engine.stop(), [engine]);
  const undo = useCallback(() => engine.undo(), [engine]);
  const toggle = useCallback(() => {
    if (engine.listening()) engine.stop();
    else start();
  }, [engine, start]);

  return { supported, listening: state.listening, canUndo: state.canUndo, start, stop, undo, toggle };
}
