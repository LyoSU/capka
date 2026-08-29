"use client";

import { Markdown } from "@/components/chat/markdown";
import { CitedSourcesFooter } from "@/components/chat/sources";
import type { NumberedSource } from "@/lib/mcp/search-normalize";

const SOURCES: NumberedSource[] = [
  { n: 1, title: "AI Updates Today — Daily AI News & Model Releases | AIToolsRecap", url: "https://aitoolsrecap.com/news/today", snippet: "", date: "2026-08-27" },
  { n: 6, title: "xigh/open-weight-models", url: "https://github.com/xigh/open-weight-models", snippet: "" },
  { n: 9, title: "Best Open Source AI Models for Coding (2026)", url: "https://kilo.ai/blog/best-open-source-ai-models", snippet: "", date: "2026-08-20" },
];

const TEXT = `Here are the main things that moved in the industry over the last few days:

**Open-weight and local models**

- **GLM-5.3 / 5.2 from Zhipu AI** [1, 9]: Chinese open weights keep pressing hard on the commercial APIs, especially at coding and agentic pipelines [9].
- **Google's Gemma 4 series** [6]: mid-sized models (12B/31B, context up to 256K, Apache 2.0) [6] have become about the most popular pick for running locally.
- **Qwen3 Coder** [9]: Alibaba's line has settled in near the top of the open models [1, 6, 9].

An unknown source stays plain text: [7], and so does a mixed group: [1, 7]. A marker inside \`code [1]\` is left alone.

\`\`\`
[1] inside a fence stays as it is
\`\`\`

An ordinary [link with its own text](https://example.com/page) works as always.`;

export function CitationsHarness() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
      <div className="chat-prose text-base leading-relaxed">
        <Markdown chatId="dev" sources={SOURCES}>{TEXT}</Markdown>
      </div>
      <CitedSourcesFooter list={SOURCES} />
    </main>
  );
}
