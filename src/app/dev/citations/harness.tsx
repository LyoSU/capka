"use client";

import { Markdown } from "@/components/chat/markdown";
import { CitedSourcesFooter } from "@/components/chat/sources";
import type { NumberedSource } from "@/lib/mcp/search-normalize";

const SOURCES: NumberedSource[] = [
  { n: 1, title: "AI Updates Today — Daily AI News & Model Releases | AIToolsRecap", url: "https://aitoolsrecap.com/news/today", snippet: "", date: "2026-08-27" },
  { n: 6, title: "xigh/open-weight-models", url: "https://github.com/xigh/open-weight-models", snippet: "" },
  { n: 9, title: "Best Open Source AI Models for Coding (2026)", url: "https://kilo.ai/blog/best-open-source-ai-models", snippet: "", date: "2026-08-20" },
];

const TEXT = `Ось головні цікавинки та тренди в індустрії за останні дні:

**Open-weight та локальні моделі**

- **GLM-5.3 / 5.2 від Zhipu AI** [1, 9]: китайські відкриті ваги продовжують активно тиснути на комерційні API, особливо в задачах кодингу та агентних пайплайнах [9].
- **Серія Gemma 4 від Google** [6]: моделі середнього розміру (12B/31B з контекстом до 256K під Apache 2.0) [6] стали чи не найпопулярнішим вибором для локального запуску.
- **Qwen3 Coder** [9]: лінійка від Alibaba закріпилась у топі відкритих моделей [1, 6, 9].

Невідоме джерело лишається текстом: [7], мішана група теж: [1, 7]. Маркер у \`коді [1]\` не чіпається.

\`\`\`
[1] у фенсі теж лишається як є
\`\`\`

Звичайне посилання [зі своїм текстом](https://example.com/page) живе як завжди.`;

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
