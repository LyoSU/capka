"use client";

import { useEffect, useMemo, useState } from "react";
import { Streamdown, defaultRemarkPlugins, defaultUrlTransform, type Components, type PluginConfig, type UrlTransform } from "streamdown";
import "streamdown/styles.css";
// KaTeX ships its own stylesheet (fonts + layout). Without it the math plugin
// renders raw, unstyled spans instead of typeset formulas — Streamdown does not
// bundle it, so import it here where the math plugin is wired in.
import "katex/dist/katex.min.css";
import { remarkWorkspacePaths, makeWorkspaceComponents, LiveContext } from "./workspace-path";
import { remarkCitations } from "@/lib/chat/citations";
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

// How a streamed answer becomes live text rather than text arriving in slabs. The
// runner flushes every ~100ms and the client coalesces deltas into ~250ms batches,
// so a paragraph would otherwise grow in jumps of twenty-odd tokens four times a
// second. Streamdown animates only the words the latest batch mounted, staggered
// so a typical batch (eight to twelve words) unrolls across roughly the interval to
// the next one — the eye reads a flow, not a beat. Opacity only: blur or motion on
// every word of every reply is exactly the per-token treatment the step rail
// refuses. `--ease-out` is the app's one entrance curve, so its literal value goes
// here rather than a second opinion. When `isAnimating` goes false the plugin
// leaves the pipeline, so a finished message carries no extra spans. Module-level
// because the memo compares it by reference.
const ANIMATED = {
  animation: "fadeIn",
  duration: 220,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  sep: "word",
  stagger: 24,
} as const;

// Syntax highlighting (shiki), math (katex) and diagrams (mermaid) are heavy —
// load them off the critical path so the chat bundle stays small. Markdown
// renders immediately; code/math/diagrams upgrade in once the chunk arrives.
// One shared promise so all messages reuse a single import.
let pluginsPromise: Promise<PluginConfig> | null = null;
function loadPlugins(): Promise<PluginConfig> {
  pluginsPromise ??= Promise.all([
    import("@streamdown/code"),
    import("@streamdown/math"),
    import("@streamdown/mermaid"),
  ]).then(([code, math, mermaid]) => ({
    code: code.createCodePlugin({ themes: ["github-light", "github-dark"] }),
    math: math.math,
    mermaid: mermaid.mermaid,
  }));
  return pluginsPromise;
}

export function Markdown({ children, isStreaming, chatId, sources }: { children: string; isStreaming?: boolean; chatId?: string; sources?: NumberedSource[] }) {
  const [plugins, setPlugins] = useState<PluginConfig | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    loadPlugins().then((p) => alive && setPlugins(p));
    return () => {
      alive = false;
    };
  }, []);

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
    // `isAnimating` reaches Streamdown as a compared prop, and the file chips read
    // the same flag from `LiveContext`, so the end of a turn is now a re-render of
    // the blocks that changed, not a teardown.
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
