"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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

/** The chat a run of facts came out of, when there is one to open. `legacy` and
 *  `unknown` name no conversation and get no link — a caption that looked clickable and
 *  went nowhere would be worse than a plain sentence. */
export function chatHref(source: FactSource): string | null {
  if (source.kind === "chat") return `/chat/${source.chatId}`;
  if (source.kind === "chats") return `/chat/${source.latest.chatId}`;
  return null;
}

/** The caption over a run of facts that all came from one place.
 *
 *  A LINK when the conversation still exists, because the sentence alone answers "where
 *  did this come from" and not "is that really what I said" — and the second question is
 *  the one a person asks about a fact they do not recognise. The whole caption is the
 *  link rather than the chat's title alone: the title is interpolated into a localized
 *  sentence, and slicing a link out of the middle of one means `t.rich` and a second
 *  shape for translators to keep in step, for a target a few pixels wider. */
export function SourceCaption({ children, href }: { children: React.ReactNode; href?: string | null }) {
  const className = "px-4 pt-2.5 text-[11.5px] leading-relaxed text-muted-foreground";
  if (!href) return <p className={className}>{children}</p>;
  return (
    <p className={className}>
      <Link
        href={href}
        className="rounded-sm underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </Link>
    </p>
  );
}

/** The source sentence for one entry, in the reader's language — the value
 *  `groupBySource` compares runs on, and the text `SourceCaption` prints. */
export function useSourceText(): (source: FactSource) => string {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  return (source) => formatSource(source, locale, t);
}

/**
 * One record's text — blurred behind a reveal control when it is marked sensitive.
 *
 * This used to print a fixed apology in place of the words, because the projection sent
 * `null` for them. That was the manifest's rule applied at the wrong entrance:
 * `sensitive` withholds from the MODEL, and the person reading this page is the owner of
 * the space. Withholding from them cost two things — a fact they could not judge, and (on
 * the waiting list) a Keep button over a blank row.
 *
 * What genuinely applies at a screen is shoulder-surfing, so the defence is a RENDERING
 * one: blurred by default, one click to read, per row and never sticky. Reachable by
 * keyboard because it is an ordinary button, and it does not animate under
 * `prefers-reduced-motion`.
 *
 * While blurred the text is `aria-hidden`: a screen reader that read it aloud anyway
 * would defeat the point in the one room where somebody else can hear. The reason it is
 * hidden is carried in a visually-hidden line, so a reader who cannot see the blur is
 * still told what the control is for.
 *
 * `children` — a row's version history, the other half of a conflict — hang off the SAME
 * reveal rather than getting one each. They are the same fact in different words, and two
 * controls over one secret is a way to leave half of it on screen.
 */
export function Statement({
  text,
  sensitive,
  children,
}: {
  text: string;
  sensitive: boolean;
  children?: React.ReactNode;
}) {
  const t = useTranslations("settings.memory");
  const [shown, setShown] = useState(false);
  const textId = useId();

  if (!sensitive) {
    return (
      <>
        <p className="text-sm leading-snug">{text}</p>
        {children}
      </>
    );
  }

  return (
    <>
      <p
        id={textId}
        aria-hidden={!shown}
        className={cn(
          "text-sm leading-snug transition-[filter] motion-reduce:transition-none",
          !shown && "select-none blur-[5px]",
        )}
      >
        {text}
      </p>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={textId}
        onClick={() => setShown((v) => !v)}
        className="-mx-1 mt-1 block rounded-md px-1 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {shown ? t("hide") : t("reveal")}
        {!shown && <span className="sr-only"> — {t("sensitiveBlurred")}</span>}
      </button>
      {shown && children}
    </>
  );
}

/** One row. Tight on purpose: these are single sentences, and the difference between a
 *  fact and where it came from is carried by the type scale, not by padding.
 *
 *  `group/fact` is named rather than anonymous because `MemoryReview` draws its rows with
 *  this same component: an unnamed group would make a waiting row's hover reveal the
 *  delete control of whichever fact row happened to nest above it. */
export function FactRow({ children }: { children: React.ReactNode }) {
  return <div className="group/fact px-4 py-2">{children}</div>;
}

/**
 * Delete one fact — the ONLY thing a person can do to a sensitive one.
 *
 * Sensitive claims are the reason this exists at all. Their text is withheld from the
 * manifest, from `memory_search` and from the agent, so `memory_forget` cannot act on
 * one: forgetting through the agent means naming the claim's own words, and the words
 * are precisely what is hidden. A click sends an id and no text, so the same control
 * serves both kinds without a branch.
 *
 * CONFIRMED, and the dialog is the smaller of two mistakes. These rows are one line tall
 * and stacked on a hairline, so a bare one-click destroy sits a few pixels from the row
 * above it with no undo behind it — and there is no undo to build, since `forgetClaim`
 * ends a claim's chain. The dialog names nothing about the fact (not even a
 * non-sensitive statement): one confirmation reads the same for every row, and quoting
 * the text would give a sensitive row a second, emptier dialog of its own.
 *
 * VISIBILITY, deliberately not hover-only: hover-only is unreachable by keyboard and
 * simply absent on touch. The control is always in the tab order, appears on focus, and
 * is permanently visible where there is no hover to have (`pointer-coarse`).
 */
function DeleteFact({ fact, onChanged }: { fact: FactView; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/claims/${encodeURIComponent(fact.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      // Re-read rather than splice locally: deleting the last fact in a topic empties the
      // topic, and the server is what decides whether the topic is still on the page.
      onChanged();
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogTrigger
        render={
          <button
            type="button"
            disabled={busy}
            aria-label={t("deleteFact")}
            className={cn(
              "relative mt-0.5 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md",
              // A 28px icon inside a 40px touch target — the row is denser than a finger.
              "before:absolute before:-inset-1.5 before:content-['']",
              "text-muted-foreground hover:bg-hover hover:text-destructive",
              "opacity-0 transition-opacity motion-reduce:transition-none",
              "focus:opacity-100 group-hover/fact:opacity-100 pointer-coarse:opacity-100 data-[popup-open]:opacity-100",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <Trash2 aria-hidden className="size-3.5" />
          </button>
        }
      />
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteFactConfirm")}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteFactConfirmBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={remove}>{t("deleteFact")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Fact({ fact, onChanged }: { fact: FactView; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <FactRow>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* The history hangs off the reveal for a sensitive fact — see `Statement`:
              the previous version is the same words one revision earlier, so a
              disclosure of its own would put half the secret back on screen. */}
          <Statement text={fact.statement} sensitive={fact.sensitive}>
            {fact.previous && (
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
          </Statement>
        </div>
        <DeleteFact fact={fact} onChanged={onChanged} />
      </div>
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
export function MemoryTopics({ topics, onChanged }: { topics: TopicView[]; onChanged: () => void }) {
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
                {/* A run shares one source SENTENCE, so it shares the conversation the
                    sentence names — the first item's is every item's. */}
                <SourceCaption href={chatHref(run.items[0].source)}>{run.source}</SourceCaption>
                {run.items.map((fact) => (
                  <Fact key={fact.id} fact={fact} onChanged={onChanged} />
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
