"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

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

/** How long "starting" may last before the composer tells the person to look for
 *  the browser's microphone prompt. */
export const PENDING_HINT_MS = 4000;

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
  /** Audio capture actually began — the permission prompt is behind us. Optional:
   *  the fake in the suite never fires it, and the first result implies it. */
  onaudiostart?: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * What the UI has to say out loud. Every value maps to one plain sentence for the
 * person, because "nothing happens" is the failure mode a silent microphone leaves
 * them with: a browser that never got the permission, no microphone at all, a speech
 * service it cannot reach, a page served over plain HTTP, a language the engine does
 * not have. `pending` is not a failure — the browser is still asking for permission —
 * but after a few seconds of that the person deserves to be told where to look, and
 * `silence` is the microphone closing itself after hearing nothing for a long while,
 * which has to be said out loud or the button just goes dark on its own.
 */
export type DictationErrorKind =
  | "permission"
  | "pending"
  | "silence"
  | "no-microphone"
  | "network"
  | "language"
  | "insecure"
  | "failed";

/** Where a dictation session is: not running, waiting for audio (permission prompt,
 *  device warm-up), or actually hearing. Drives the composer's placeholder. */
export type DictationPhase = "idle" | "starting" | "hearing";

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
 * Languages the microphone popover offers. The engine cannot detect a language —
 * `lang` is one tag per session and nothing in the result says what was heard —
 * so a person who reads the UI in one language and speaks another has to say so
 * once. The list is the UI locale first, then whatever the browser is set to
 * (a bilingual person usually has both there), then a short common set; the
 * remembered choice is kept even when it comes from none of those.
 */
const COMMON_SPEECH_LANGS = ["en-US", "uk-UA", "en-GB", "pl-PL", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "tr-TR", "ru-RU"];

export function dictationLanguages(locale: string, browser: readonly string[], chosen?: string): string[] {
  const all = [speechLangFor(locale), ...browser.map(speechLangFor), ...(chosen ? [chosen] : []), ...COMMON_SPEECH_LANGS].filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of all) {
    // A browser often lists a bare "ru" beside our "ru-RU": one language, and the
    // regioned tag is the one the engines prefer, so it stands in for the bare one.
    const pick = tag.includes("-") ? tag : all.find((t) => t.toLowerCase().startsWith(tag.toLowerCase() + "-")) ?? tag;
    const key = pick.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pick);
  }
  return out;
}

/**
 * What the picker prints for each tag, in the UI language, capitalised the way a
 * list wants it. The region is spelled out only when the same language appears
 * twice ("American English" / "British English"); a language present once is just
 * its name — "Ukrainian (Ukraine)" says nothing "Ukrainian" does not.
 */
export function speechLangLabels(tags: readonly string[], locale: string): { value: string; label: string }[] {
  const baseCount = new Map<string, number>();
  for (const t of tags) {
    const base = t.toLowerCase().split("-")[0];
    baseCount.set(base, (baseCount.get(base) ?? 0) + 1);
  }
  return tags.map((tag) => {
    const base = tag.split("-")[0];
    return { value: tag, label: speechLangLabel((baseCount.get(base.toLowerCase()) ?? 0) > 1 ? tag : base, locale) };
  });
}

export function speechLangLabel(tag: string, locale: string): string {
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames([locale], { type: "language" }).of(tag);
  } catch {
    // An unknown or malformed tag: the tag itself is the honest label.
  }
  const s = name ?? tag;
  return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
}

const DICTATION_LANG_KEY = "capka.dictation.lang";

function subscribeDictationLang(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

/**
 * The remembered dictation language, per browser: a choice about how a person
 * speaks, not about a chat, so it is not keyed by chat. Falls back to the UI locale
 * until one is made. The synthetic `storage` event is what makes a change in the
 * popover reach the composer in the same document.
 */
export function useDictationLang(locale: string): [string, (tag: string) => void] {
  const fallback = speechLangFor(locale);
  const lang = useSyncExternalStore(
    subscribeDictationLang,
    () => {
      try {
        return localStorage.getItem(DICTATION_LANG_KEY) || fallback;
      } catch {
        return fallback;
      }
    },
    () => fallback,
  );
  const set = useCallback((tag: string) => {
    try {
      localStorage.setItem(DICTATION_LANG_KEY, tag);
      window.dispatchEvent(new StorageEvent("storage", { key: DICTATION_LANG_KEY }));
    } catch {
      // Storage refused (private mode, quota): the store is the only source of
      // truth here, so the choice cannot take. The picker snaps back, which is
      // at least visible.
    }
  }, []);
  return [lang, set];
}

/**
 * Append one recognised phrase to what we already have. Trimming each phrase
 * before joining is what keeps a single space between them however the engine
 * pads its own output — the doubled spaces come from the engine, not from us.
 *
 * A phrase that CONTAINS everything so far replaces it rather than following it.
 * Chrome for Android sends its newest final as a concatenation of every final
 * before it (crbug.com/41186589), which desktop Chrome never does, and Safari
 * re-lists a run once the speaker pauses.
 *
 * A phrase that merely EQUALS what is already there is where the two failures
 * meet, because by text alone an engine's echo and a word the speaker said twice
 * are the same thing. The line is drawn at one word: people repeat single words —
 * "very very", "no no" — and do not repeat a whole phrase verbatim with nothing
 * in between, whereas an engine restating a run always restates the phrase. A
 * heuristic, and deliberately the timid one: a duplicate on screen can be deleted,
 * a word that never arrived is never noticed.
 */
export function appendPhrase(acc: string, phrase: string): string {
  const piece = phrase.trim();
  if (!piece) return acc;
  if (!acc) return piece;
  if (piece === acc) return piece.includes(" ") ? acc : `${acc} ${piece}`;
  return piece.startsWith(`${acc} `) ? piece : `${acc} ${piece}`;
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
  phase(): DictationPhase;
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
  /** What recognition runs that have already ended said. */
  let carried = "";
  /** What the run in progress has said so far. Recomputed wholesale each event. */
  let spoken = "";
  /** Everything the run in progress has ever reported, including what a re-aim has
   *  since turned into ordinary composer text. Its events restate this prefix. */
  let runText = "";
  /** The part of `runText` that is already sitting in `before`. Subtracted from
   *  every later event so a re-aim does not have to reopen the run. */
  let consumed = "";

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
  /** Why the last run ended, for a session that runs out of patience and has to
   *  say something. Silence is the ordinary case; a dead speech service the other. */
  let giveUp: DictationErrorKind = "silence";
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let phase: DictationPhase = "idle";

  const listening = () => wanted;
  const phaseOf = () => phase;
  const setPhase = (next: DictationPhase) => {
    if (phase === next) return;
    phase = next;
    host.changed();
  };
  const canUndo = () => snapshot !== null;

  const dictated = () => appendPhrase(carried, spoken);

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
    spoken = "";
    runText = "";
    consumed = "";
    // The composer holds exactly what we last left there, which is what it holds
    // now: without this a keystroke landing before the first phrase would look
    // like our own writing and be painted over.
    written = value;
  };

  /**
   * Take the composer as it stands as the new starting point: what is there is
   * ordinary text now, and the next phrase lands at the caret. The run in progress
   * is left alone — it keeps restating what it has heard, and `consumed` is how
   * much of that restatement is already in `before`. Reopening the run instead
   * would abort and restart recognition on every keystroke, which is a good way to
   * make an engine stop answering.
   */
  const retarget = (value: string) => {
    const { start, end } = host.getSelection();
    before = value.slice(0, start);
    after = value.slice(end);
    carried = "";
    spoken = "";
    consumed = runText;
    written = value;
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
    // Detached like the rest: a late audiostart after abort/unmount would otherwise
    // put the phase back to "hearing" for a run that is already over.
    r.onaudiostart = null;
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

    r.onaudiostart = () => setPhase("hearing");
    r.onresult = (event) => {
      heard = true;
      barren = 0;
      setPhase("hearing");
      // React reports a keystroke one tick late. If the composer already holds one,
      // take it as the new starting point BEFORE this phrase lands — a repaint from
      // the engine's own baseline would write the character back out of existence,
      // and nothing could restore it, because the `syncValue` that follows finds
      // exactly the text it just wrote and concludes nothing happened.
      const live = host.getValue();
      if (live !== written) retarget(live);
      // Recompute the whole run from its results rather than tracking deltas:
      // the engine revises earlier phrases as it hears more, and `results` is
      // always the authoritative list for the run in progress. Whether a
      // result is final or still a guess makes no difference to what the
      // composer shows, so the two are not kept apart — which also sidesteps
      // Safari, where `isFinal` may never come.
      let text = "";
      const list = event.results;
      for (let i = 0; i < list.length; i++) {
        const piece = (list[i]?.[0]?.transcript ?? "").trim();
        if (!piece) continue;
        text = appendPhrase(text, piece);
      }
      runText = text;
      spoken = text.startsWith(consumed) ? text.slice(consumed.length).trimStart() : text;
      paint();
    };

    r.onerror = (event) => {
      const code = event?.error;
      if (code === "aborted") return; // Our own `stop()` on the way out.
      // Chrome answers a few seconds of silence with an ERROR and closes the run,
      // continuous or not — and in continuous mode it reaches for `network` about
      // as readily as for `no-speech`. Neither can end a session someone is still
      // talking into; `onend` reopens the run, and the barren counter is what stops
      // that becoming a storm on a microphone or a speech service that is truly gone.
      if (code === "no-speech") {
        giveUp = "silence";
        return;
      }
      if (code === "network") {
        giveUp = "network";
        return;
      }
      terminal = true;
      if (code === "not-allowed" || code === "service-not-allowed") {
        host.failed("permission");
      } else if (code === "audio-capture") {
        host.failed("no-microphone");
      } else if (code === "language-not-supported") {
        host.failed("language");
      } else {
        host.failed("failed");
      }
    };

    r.onend = () => {
      // Chrome ends a run of its own accord after a pause, well before the user
      // is done talking (on Android, after every phrase). Carry what it said
      // over — guesses included, or a run that ends before firming up its last
      // words would drop the sentence just spoken — and open the next run so
      // the session looks continuous, unless something told us to stop.
      carried = appendPhrase(carried, spoken);
      spoken = "";
      // A run that heard nothing and ended immediately would otherwise reopen
      // forever; three in a row means the engine is refusing, not pausing.
      barren = heard ? 0 : barren + 1;
      const exhausted = barren > 3;
      if (!wanted || terminal || disposed || exhausted) {
        // Going dark without a word is indistinguishable from a dead button, and
        // the person is usually still talking when it happens.
        if (exhausted && wanted && !terminal && !disposed) host.failed(giveUp);
        finish();
        return;
      }
      recognition = null;
      runText = "";
      consumed = "";
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
    phase = "idle";
    clearCap();
    release();
    paint();
    if (was) host.changed();
  };

  const start = () => {
    if (disposed || wanted) return;
    if (!host.create && !speechRecognitionCtor()) return;
    // The constructor exists on plain HTTP too, and `start()` then fails in a way
    // that looks like a dead button. Say the real reason before touching it.
    if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) {
      host.failed("insecure");
      return;
    }
    baseline();
    wanted = true;
    terminal = false;
    barren = 0;
    giveUp = "silence";
    phase = "starting";
    if (!run()) {
      wanted = false;
      snapshot = null;
      phase = "idle";
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
    phase = "idle";
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
      phase = "idle";
      clearCap();
      release();
    }
    snapshot = null;
    before = "";
    after = "";
    carried = "";
    spoken = "";
    runText = "";
    consumed = "";
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
    // Still listening — re-aim at wherever the caret is now, so the next phrase
    // lands where the user is looking instead of at a stale offset. The undo stays
    // gone: it promised the text as it was before dictation, and the user has since
    // written something it would throw away.
    if (wanted) retarget(value);
    host.changed();
  };

  const dispose = () => {
    disposed = true;
    wanted = false;
    phase = "idle";
    clearCap();
    release();
  };

  return { listening, phase: phaseOf, canUndo, start, stop, undo, syncValue, dispose };
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
  phase: DictationPhase;
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
  const [state, setState] = useState<{ listening: boolean; phase: DictationPhase; canUndo: boolean }>({ listening: false, phase: "idle", canUndo: false });

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
        setState({ listening: engine.listening(), phase: engine.phase(), canUndo: engine.canUndo() });
      },
      failed: (kind) => latest.current.onError?.(kind),
      lang: () => speechLangFor(latest.current.lang),
    });
  }
  const engine = engineRef.current;

  useEffect(() => {
    setSupported(isDictationSupported());
  }, []);

  // Still "starting" after a few seconds means the browser is waiting on the person
  // — a permission prompt they have not seen, or one the OS is holding — and from
  // the composer that is indistinguishable from a dead button. Say where to look.
  useEffect(() => {
    if (state.phase !== "starting") return;
    const timer = setTimeout(() => latest.current.onError?.("pending"), PENDING_HINT_MS);
    return () => clearTimeout(timer);
  }, [state.phase]);

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

  // The engine lives in a ref for the component's whole life, and React's dev
  // strict mode runs every effect twice — mount, cleanup, mount — with the SAME
  // ref. A cleanup that disposed the engine left a permanently dead one behind:
  // every later `start()` returned on its first line and the microphone button
  // did nothing in development while working fine in production. Stopping is all
  // an unmount needs (the recognition run is released, the cap timer cleared),
  // and a stopped engine can start again.
  useEffect(() => () => engine.stop(), [engine]);

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

  return { supported, listening: state.listening, phase: state.phase, canUndo: state.canUndo, start, stop, undo, toggle };
}
