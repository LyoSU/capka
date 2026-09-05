"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown, defaultRemarkPlugins, defaultUrlTransform, type CodeHighlighterPlugin, type Components, type PluginConfig, type UrlTransform } from "streamdown";
import "streamdown/styles.css";
// KaTeX ships its own stylesheet (fonts + layout). Without it the math plugin
// renders raw, unstyled spans instead of typeset formulas — Streamdown does not
// bundle it, so import it here where the math plugin is wired in.
import "katex/dist/katex.min.css";
import { remarkWorkspacePaths, makeWorkspaceComponents, LiveContext } from "./workspace-path";
import { remarkCitations } from "@/lib/chat/citations";
import { openFenceBody, deferLiveHighlight } from "@/lib/chat/live-code";
import type { Pluggable } from "unified";
import type { NumberedSource } from "@/lib/mcp/search-normalize";

// Default remark pipeline + our /workspace path linker. Passing remarkPlugins
// replaces Streamdown's defaults, so re-include them (gfm, codeMeta) to keep GFM
// tables etc.; ours runs last so it sees plain text.
const REMARK_WITH_PATHS = [...Object.values(defaultRemarkPlugins), remarkWorkspacePaths];

// Keep relative /workspace links intact (the chip handles them); defer all other
// URLs to Streamdown's normal sanitizing transform.
const urlTransform: UrlTransform = (url, key, node) =>
  url.startsWith("/workspace/") ? url : defaultUrlTransform(url, key, node);

// Stable identities so Streamdown's React.memo actually holds — passing a fresh
// array/object literal every render defeated the memo and re-rendered the whole
// markdown tree of every message on each SSE token and every keystroke.
const STREAMDOWN_CONTROLS = {
  code: { copy: true },
  table: { copy: true, download: true, fullscreen: true },
};

// Each streamed word fades in once, on its own. The fade was removed for a while
// because it sat on top of ~250ms server slabs: twenty words flashing in from
// transparent together, four times a second, read as blinking. The slabs are gone
// — deltas are paced word by word on the client (src/lib/chat/delta-pacer.ts) —
// and a fade on each paced word is a different thing: the leading edge of the
// text becomes a soft gradient (the newest word lightest) instead of a hard
// front, which is what a smooth token stream looks like on a 120Hz display.
// Streamdown animates only the words past the previous render's length, skips
// `code`/`pre`/`math`, and drops the spans when `isAnimating` goes false, so a
// finished message carries no extra markup. `stagger: 0` is load-bearing: the
// plugin cascades per BLOCK, so any stagger restarts the tail in every paragraph
// and a reply grows two fronts at once. `--ease-out` is the app's one entrance
// curve; its literal value goes here because the memo compares this object by
// reference and it must be module-level.
const ANIMATED = {
  animation: "fadeIn",
  duration: 220,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  sep: "word",
  stagger: 0,
} as const;

// Syntax highlighting (shiki), math (katex) and diagrams (mermaid) are heavy — each
// is megabytes of chunk, and mermaid alone drags in d3 and cytoscape. They load per
// PLUGIN, and only when the text being rendered actually asks for one, so a chat of
// ordinary prose never pays for any of them. A reply that grows a fence mid-stream
// picks its plugin up on the next render.
//
// Independent, NOT one Promise.all: a single failed chunk used to take the other two
// down with it, and the rejected promise stayed cached forever, so nothing retried —
// one flaky download left the whole transcript unhighlighted until a reload. Each
// loader clears its own slot on failure instead, so the next render tries again.
const LOADERS = {
  code: () => import("@streamdown/code").then((m) => m.createCodePlugin({ themes: ["github-light", "github-dark"] })),
  math: () => import("@streamdown/math").then((m) => m.math),
  mermaid: () => import("@streamdown/mermaid").then((m) => m.mermaid),
};
type PluginName = keyof typeof LOADERS;

// Shared across every message: one download serves the whole transcript.
const loaded: Record<string, unknown> = {};
const inFlight = new Map<PluginName, Promise<unknown>>();

function load(name: PluginName): Promise<unknown> {
  let p = inFlight.get(name);
  if (!p) {
    p = LOADERS[name]().then(
      (plugin) => { loaded[name] = plugin; },
      (err) => { inFlight.delete(name); throw err; },
    );
    inFlight.set(name, p);
  }
  return p;
}

/** Which plugins this text asks for, as a stable space-joined key.
 *
 *  Over-matching only costs a chunk that wasn't needed; under-matching leaves code
 *  unhighlighted or a formula raw. So each test is the LOOSE side of what the
 *  plugin's own parser accepts: the dollar-delimited test fires on "I paid $5 and
 *  $10" exactly as remark-math itself does, which is the point — a detector pickier
 *  than the plugin it gates would hide output the plugin would have rendered.
 *
 *  Indented (four-space) code blocks are deliberately NOT detected: nothing tells
 *  them apart from an ordinary nested list, so the test would load shiki for most
 *  replies. Models emit fences; an indented block still renders as monospace, just
 *  uncoloured. */
function neededPlugins(text: string): string {
  const need: PluginName[] = [];
  if (text.includes("```") || text.includes("~~~")) need.push("code");
  if (/\$\$|\\\(|\\\[|\$[^\s$][^$\n]{0,200}\$/.test(text)) need.push("math");
  if (/```[ \t]*mermaid/i.test(text)) need.push("mermaid");
  return need.join(" ");
}

/** The subset of `need` whose chunks have already landed. */
function readyOf(need: string): string {
  return need ? need.split(" ").filter((n) => n in loaded).join(" ") : "";
}

export function Markdown({ children, isStreaming, chatId, sources }: { children: string; isStreaming?: boolean; chatId?: string; sources?: NumberedSource[] }) {
  const need = neededPlugins(children);
  // Seeded from what is already downloaded, so scrolling back to an old code block
  // paints it highlighted instead of flashing plain first.
  const [ready, setReady] = useState(() => readyOf(need));

  useEffect(() => {
    if (!need) return;
    let alive = true;
    for (const name of need.split(" ") as PluginName[]) {
      if (name in loaded) continue;
      load(name).then(() => alive && setReady(readyOf(need))).catch(() => {});
    }
    return () => { alive = false; };
  }, [need]);

  // The code block still being written is not highlighted until its fence closes
  // (see live-code.ts): shiki would re-tokenize the whole block on every paced
  // word, and that is the one render cost here that grows with the reply. The
  // ref carries the CURRENT live body so the plugin below can compare without
  // changing identity per token; only crossing a fence boundary flips `inFence`.
  const liveCode = isStreaming ? openFenceBody(children) : null;
  const liveRef = useRef(liveCode);
  liveRef.current = liveCode;
  const inFence = liveCode !== null;

  // Keyed on `ready` (a value, not a reference) so this object's identity changes
  // only when a plugin actually lands. Streamdown memoizes on it, and a fresh object
  // per render would re-parse and re-highlight the whole message on every token.
  // `inFence` is the one other key, on purpose: leaving a fence hands Streamdown a
  // new plugin object, which is what makes every code block's highlighter effect
  // run again — the block that just closed tokenizes once, the earlier ones hit
  // shiki's content cache. Without it the closed block would stay plain, because
  // its code text did not change when the fence did.
  const plugins = useMemo<PluginConfig | undefined>(() => {
    if (!ready) return undefined;
    const out: Record<string, unknown> = {};
    for (const name of ready.split(" ")) out[name] = loaded[name];
    if (inFence && out.code) {
      out.code = deferLiveHighlight(out.code as CodeHighlighterPlugin, (code) => code === liveRef.current);
    }
    return out as PluginConfig;
  }, [ready, inFence]);

  // The sources array is rebuilt by the message on every render, so the memos
  // below key on its CONTENT — a fresh array each render would defeat
  // Streamdown's memo (see STREAMDOWN_CONTROLS above).
  const citeKey = sources?.length ? sources.map((s) => `${s.n}${s.url}${s.title}${s.date ?? ""}`).join("\n") : "";

  // Clickable /workspace file chips and citation chips, in the chat transcript
  // (chatId set / sources present). Memoized so Streamdown's memo holds. The
  // streaming flag the file chips need (optimistic while live, existence-verified
  // once final) reaches them through `LiveContext` below, NOT through this
  // factory: a new `components` object can only reach Streamdown by remounting it.
  const components = useMemo<Components | undefined>(
    () => (chatId || citeKey ? makeWorkspaceComponents(chatId, sources) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sources` is represented by citeKey (content identity, not reference)
    [chatId, citeKey],
  );

  // Citation links ([N] -> source url; the a-override above upgrades them to
  // chips). The TUPLE form is load-bearing: Streamdown caches its processor
  // keyed by plugin NAME + JSON(options), so a bare closure per source set
  // would collide on name "" and hand every message the first one's processor.
  const remarkPlugins = useMemo(() => {
    const base = chatId ? REMARK_WITH_PATHS : undefined;
    if (!citeKey) return base;
    return [...(base ?? Object.values(defaultRemarkPlugins)), [remarkCitations, { sources: sources! }] as Pluggable];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sources` is represented by citeKey (content identity, not reference)
  }, [chatId, citeKey]);

  return (
    // The key is load-bearing: Streamdown's own memo comparator checks
    // `children`, `plugins`, `className`… but NOT `remarkPlugins` or
    // `components` (verified against 2.5.0). A message whose citation sources
    // resolve only at finalize (cross-turn [N] markers arrive via
    // metadata.citedSources) hands Streamdown a new citations plugin while the
    // text is already final — the comparator sees identical children and skips
    // the re-render, so the markers stayed dead until a full page reload.
    // Remounting is the only way past a memo that doesn't compare the prop, and
    // citeKey covers the full identity the chips render (number, url, title,
    // date). The key deliberately does NOT include the streaming state: that
    // flipped once per reply, at the end, and remounted the whole tree — a full
    // re-parse and re-highlight — at the very moment the eye is on the last line.
    // The file chips read the streaming flag from `LiveContext`, so the end of a
    // turn is a re-render of the blocks that changed, not a teardown.
    <LiveContext.Provider value={!!isStreaming}>
      <Streamdown
        key={citeKey}
        parseIncompleteMarkdown={isStreaming}
        isAnimating={isStreaming}
        animated={ANIMATED}
        controls={STREAMDOWN_CONTROLS}
        plugins={plugins}
        remarkPlugins={remarkPlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {children}
      </Streamdown>
    </LiveContext.Provider>
  );
}
