"use client";

import { useEffect, useMemo, useState } from "react";
import { Streamdown, defaultRemarkPlugins, defaultUrlTransform, type Components, type PluginConfig, type UrlTransform } from "streamdown";
import "streamdown/styles.css";
import { remarkWorkspacePaths, makeWorkspaceComponents } from "./workspace-path";

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

export function Markdown({ children, isStreaming, chatId }: { children: string; isStreaming?: boolean; chatId?: string }) {
  const [plugins, setPlugins] = useState<PluginConfig | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    loadPlugins().then((p) => alive && setPlugins(p));
    return () => {
      alive = false;
    };
  }, []);

  // Clickable /workspace file chips only in the chat transcript (where chatId is
  // set and a PreviewProvider is mounted). Memoized so Streamdown's memo holds;
  // `isStreaming` is a dep so chips switch from optimistic to existence-verified
  // exactly once, when the reply finalizes (not on every streamed token).
  const components = useMemo<Components | undefined>(
    () => (chatId ? makeWorkspaceComponents(chatId, isStreaming) : undefined),
    [chatId, isStreaming],
  );

  return (
    <Streamdown
      parseIncompleteMarkdown={isStreaming}
      controls={STREAMDOWN_CONTROLS}
      plugins={plugins}
      remarkPlugins={chatId ? REMARK_WITH_PATHS : undefined}
      components={components}
      urlTransform={urlTransform}
    >
      {children}
    </Streamdown>
  );
}
