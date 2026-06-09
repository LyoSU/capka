"use client";

import { useEffect, useState } from "react";
import { Streamdown, type PluginConfig } from "streamdown";
import "streamdown/styles.css";

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

export function Markdown({ children, isStreaming }: { children: string; isStreaming?: boolean }) {
  const [plugins, setPlugins] = useState<PluginConfig | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    loadPlugins().then((p) => alive && setPlugins(p));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Streamdown
      parseIncompleteMarkdown={isStreaming}
      controls={STREAMDOWN_CONTROLS}
      plugins={plugins}
    >
      {children}
    </Streamdown>
  );
}
