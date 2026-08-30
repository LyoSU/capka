"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FactSource, FactView, TopicView } from "@/lib/vault/memory-page";

/** One day, in the reader's language. Shared by the provenance line, the history
 *  disclosure and the topic's last-updated stamp so a page full of dates has ONE
 *  format on it — three call sites each calling `Intl` with their own options is how
 *  a page ends up saying "14 August", "Aug 14" and "14.08" about the same fact. */
export function formatDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-US", { day: "numeric", month: "long" })
    .format(new Date(iso));
}

/**
 * Where a fact came from, as one plain sentence.
 *
 * A separate exported function, not JSX, and deliberately so twice over: this repo's
 * vitest runs with `environment: "node"` and has no React renderer, so logic inside a
 * component cannot be tested at all; and the four shapes here (one chat, several, a
 * carried-over note, a conversation since deleted) are exactly the kind of branch that
 * rots silently. The translator gets the VALUES, never a pre-built string — Ukrainian
 * declines the words around a date differently from English.
 */
export function formatSource(
  source: FactSource,
  locale: string,
  // The value type is `next-intl`'s own, not a looser `unknown`: the whole point of
  // passing VALUES rather than a built string is that ICU formats them, and ICU has a
  // fixed set it can format. A test double with a wider parameter type still satisfies
  // this, so the narrower signature costs the test nothing.
  t: (key: string, values?: Record<string, string | number | Date>) => string,
): string {
  const day = (iso: string) => formatDay(iso, locale);
  switch (source.kind) {
    case "chat":
      return t("fromChat", { chat: source.chatTitle ?? t("untitledChat"), date: day(source.at) });
    case "chats":
      return t("fromChats", { count: source.count, chat: source.latest.chatTitle ?? t("untitledChat"), date: day(source.latest.at) });
    case "legacy":
      // The truthful thing to say about a fact carried across from the old notes: it
      // predates provenance, so naming a conversation would be an invention.
      return t("fromLegacy");
    case "unknown":
      return t("fromUnknown");
  }
}

/** A topic's name as the reader sees it. The KEY selects the copy; the stored title is
 *  the fallback for a user-named topic (plan D2), which has no translation and needs
 *  none. This is the only place a topic's display is decided — `topic_key` is what
 *  everything else joins on, which is what makes localizing this safe at all. */
export function topicLabel(
  topic: TopicView,
  t: (key: string) => string,
  has: (key: string) => boolean,
): string {
  const key = topic.topicKey ? `topics.${topic.topicKey}` : null;
  return key && has(key) ? t(key) : topic.title;
}

/**
 * The surface both lists are drawn on: ONE quiet card, rows separated by hairlines.
 *
 * It is `SettingsGroup`'s grammar because that is what this app already calls a list.
 * The first draft gave every fact its own bordered card and every WAITING fact an amber
 * fill with a dashed edge — eleven of them stacked read as eleven problems rather than
 * one calm list, which is the card-grid register the house rules put off limits, in
 * amber. "Waiting" is said ONCE, by the section heading above; repeating it on every row
 * marks nothing because it marks everything.
 */
function FactList({ children }: { children: React.ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl bg-card shadow-panel">{children}</div>;
}

/**
 * Consecutive entries sharing one provenance sentence, so the sentence is printed once.
 *
 * Six rows repeating «from the chat "…", 30 August» verbatim is noise that hides the one
 * row whose source differs — and one long extraction pass produces exactly that run.
 * CONSECUTIVE only, never a regroup of the whole list: both lists are ordered by time,
 * and gathering every same-source fact together would silently reorder facts to suit
 * their sources.
 */
export function groupBySource<T>(items: T[], sourceText: (item: T) => string): { source: string; items: T[] }[] {
  const runs: { source: string; items: T[] }[] = [];
  for (const item of items) {
    const source = sourceText(item);
    const last = runs[runs.length - 1];
    if (last && last.source === source) last.items.push(item);
    else runs.push({ source, items: [item] });
  }
  return runs;
}

/** The caption over a run of facts that all came from one place. */
export function SourceCaption({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">{children}</p>;
}

/** The source sentence for one entry, in the reader's language — the value
 *  `groupBySource` compares runs on, and the text `SourceCaption` prints. */
export function useSourceText(): (source: FactSource) => string {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  return (source) => formatSource(source, locale, t);
}

/** What a sensitive record says instead of its contents.
 *
 *  Written for a reader who does not know why it is marked and cannot find out:
 *  `sensitive` is set by an automatic screen as well as by a person, so the marking may
 *  have a cause nobody would recognise — and the text is exactly what is withheld. It
 *  therefore states the situation and never attributes the decision to the user or to
 *  the assistant, because neither is reliably true. */
export function SensitiveStatement() {
  const t = useTranslations("settings.memory");
  return <p className="text-sm italic leading-snug text-muted-foreground">{t("sensitiveHidden")}</p>;
}

/** One row. Tight on purpose: these are single sentences, and the difference between a
 *  fact and where it came from is carried by the type scale, not by padding. */
export function FactRow({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-2">{children}</div>;
}

function Fact({ fact }: { fact: FactView }) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <FactRow>
      {fact.sensitive ? <SensitiveStatement /> : <p className="text-sm leading-snug">{fact.statement}</p>}
      {/* No disclosure for a sensitive fact: its previous version is the same withheld
          words one revision earlier, and the projection does not send them. */}
      {!fact.sensitive && fact.previous && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="-mx-1 mt-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-90")}
            />
            {t("showHistory")}
          </button>
          {open && (
            <p id={panelId} className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
              {t("replaced", { statement: fact.previous.statement, date: formatDay(fact.previous.at, locale) })}
            </p>
          )}
        </>
      )}
    </FactRow>
  );
}

/**
 * The topic rail and the selected topic's facts.
 *
 * The rail is a real tablist rather than a row of divs with click handlers: every topic
 * is reachable by Tab and by arrow key, and the panel is announced as the thing the
 * selected tab controls. The mockup put a bare fact COUNT beside each name; that is not
 * built, here or later — a number is not what makes a list of topics scannable, and the
 * amendment settled on a one-line summary (plan D1 Task 9) plus the date this task
 * renders.
 */
export function MemoryTopics({ topics }: { topics: TopicView[] }) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  const sourceText = useSourceText();
  const [selected, setSelected] = useState(topics[0]?.id ?? null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelId = useId();

  // A topic can disappear under the selection between two loads (a fact deleted, the
  // whole topic emptied). Falling back to the first one keeps the panel from going
  // blank with a rail that still looks like something is chosen.
  useEffect(() => {
    if (!topics.some((x) => x.id === selected)) setSelected(topics[0]?.id ?? null);
  }, [topics, selected]);

  if (!topics.length) return null;
  const active = topics.find((x) => x.id === selected) ?? topics[0];

  const move = (from: number, delta: number) => {
    const next = (from + delta + topics.length) % topics.length;
    setSelected(topics[next].id);
    tabs.current[next]?.focus();
  };

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[220px_1fr]">
      <div role="tablist" aria-orientation="vertical" aria-label={t("topicsLabel")} className="flex flex-col gap-1">
        {topics.map((topic, i) => {
          const on = topic.id === active.id;
          return (
            <button
              key={topic.id}
              ref={(el) => { tabs.current[i] = el; }}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={panelId}
              onClick={() => setSelected(topic.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); move(i, 1); }
                if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); move(i, -1); }
                if (e.key === "Home") { e.preventDefault(); move(0, 0); }
                if (e.key === "End") { e.preventDefault(); move(topics.length - 1, 0); }
              }}
              className={cn(
                "rounded-[9px] px-3 py-2 text-left text-[13.5px] transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "bg-card font-[550] shadow-panel" : "hover:bg-hover",
              )}
            >
              <span className="block truncate">{topicLabel(topic, t as (k: string) => string, (k) => t.has(k as never))}</span>
              {topic.lastUpdatedAt && (
                <span className="mt-0.5 block text-[11.5px] font-normal text-muted-foreground">
                  {t("updated", { date: formatDay(topic.lastUpdatedAt, locale) })}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div id={panelId} role="tabpanel" className="min-w-0">
        {active.facts.length ? (
          <FactList>
            {groupBySource(active.facts, (f) => sourceText(f.source)).map((run) => (
              <div key={`${run.source}:${run.items[0].id}`} className="pb-1.5">
                <SourceCaption>{run.source}</SourceCaption>
                {run.items.map((fact) => (
                  <Fact key={fact.id} fact={fact} />
                ))}
              </div>
            ))}
          </FactList>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">{t("topicEmpty")}</p>
        )}
      </div>
    </div>
  );
}
