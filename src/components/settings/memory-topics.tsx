"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
// TYPE-ONLY from the projection module, which opens a database connection at import: a
// type is erased and a VALUE would drag `pg` into this client bundle. The section tuple is
// a value, so it comes from the import-free module that owns it.
import { TOPIC_SECTIONS, type TopicSection } from "@/lib/vault/memory-sections";
import type { FactSource, FactView, StatementView, TopicView, TrustTag } from "@/lib/vault/memory-page";
import { SettingsGroup, SettingsSection } from "./shell";

/** One day, in the reader's language. Shared by the provenance line and the history
 *  disclosure so a page full of dates has ONE format on it — call sites each calling
 *  `Intl` with their own options is how a page ends up saying "14 August", "Aug 14" and
 *  "14.08" about the same fact. */
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

/**
 * WHERE A ROW CAME FROM, in three or four words, on every row.
 *
 * This is the one thing the release that lets the agent write unattended cannot ship
 * without (§11.9): with the confirmation gate gone, a person's own statement and the
 * assistant's guess about them sit in one list, and nothing else on the row tells them
 * apart. Flattening the two into one generic card is how «Director: Olena», lifted out of
 * a 2019 contract, comes to read as a confirmed personal fact.
 *
 * The `satisfies` is the load-bearing part, not decoration: a sixth `TrustTag` arm is a
 * COMPILE ERROR here rather than a badge with a missing label, which is the link
 * `t(`trust.${kind}`)` would sever — the union in one file, the strings in another, and
 * nothing in between.
 */
const TRUST_KEY = {
  user_direct: "trust.userDirect",
  owner_authored: "trust.ownerAuthored",
  agent_inferred: "trust.agentInferred",
  untrusted_document: "trust.untrustedDoc",
  untrusted_web: "trust.untrustedWeb",
} satisfies Record<TrustTag["kind"], string>;

/**
 * The trust tag, and the sensitive marker beside it when there is one.
 *
 * TWO CHIPS AND NOT ONE, because they answer two questions: the first is where the fact
 * came from, the second is who may read it. A single merged label would have to drop one
 * of them, and `sensitive` collapses every class to one channel — so merging would lose
 * exactly the provenance this tag exists to show.
 *
 * QUIET BY DESIGN. Fifty facts each wearing a coloured pill is fifty alerts; these are
 * captions in the row's own type scale, and the only one that takes any colour at all is
 * the sensitive marker, which is genuinely about who can see the words.
 *
 * IT TAKES THE WHOLE `StatementView`, not a `sensitive` boolean, and that is not a style
 * choice: `sensitive` is read in exactly one module (`memory-statement.test.ts` asserts it
 * as an equality), because a second reader is a second copy of the rule and a second copy
 * is how the conflict line and the edit textarea both shipped broken. A caller hands over
 * the value; this file decides.
 */
export function TrustBadge({ trust, value }: { trust: TrustTag; value: StatementView }) {
  const t = useTranslations("settings.memory");
  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
      {/* The document's name travels as a VALUE, never interpolated here: Ukrainian
          declines the words around a quoted title. */}
      <span>{trust.kind === "untrusted_document" ? t(TRUST_KEY[trust.kind], { name: trust.name }) : t(TRUST_KEY[trust.kind])}</span>
      {value.sensitive && <span className="text-warning-text">{t("trust.sensitive")}</span>}
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
 * WHETHER A STORED STATEMENT IS LEGIBLE — the ONE place `sensitive` is read to decide it,
 * and the reason `StatementView` pairs the flag with the text rather than sitting beside
 * it.
 *
 * A row that needs the answer for something other than rendering the words — the memory
 * queue disables "Edit wording" until the person has revealed the fact — takes this hook
 * and reads `shown`. It never sees `sensitive`, so it cannot grow a second copy of the
 * rule, which is precisely what happened at the conflict line and the edit textarea.
 *
 * A non-sensitive statement is `shown` from the start and has no control: `shown` answers
 * "may this be read", not "did somebody click".
 */
export function useReveal(value: StatementView): { shown: boolean; toggle: () => void } {
  const [revealed, setRevealed] = useState(false);
  return { shown: !value.sensitive || revealed, toggle: () => setRevealed((v) => !v) };
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
 * controls over one secret is a way to leave half of it on screen. A statement nested
 * INSIDE those children (the contested head, the previous version) is a different fact and
 * does get its own, because its sensitivity is its own.
 *
 * The toggle is deliberately a small trailing affordance on the statement's own line, not
 * a block button above the row's actions: it changes what is legible, and rendered as a
 * peer of Keep/Discard it read as a fourth decision.
 */
export function Statement({
  value,
  reveal,
  className,
  children,
}: {
  value: StatementView;
  /** Share the row's own reveal state, when something outside the text depends on it.
   *  Omit and the component keeps its own. */
  reveal?: { shown: boolean; toggle: () => void };
  /** Type scale for the surrounding context — a row's own sentence, a history panel, a
   *  conflict line. Presentation only: there is deliberately no prop that changes whether
   *  the text is legible, because that is the one decision this component owns. */
  className?: string;
  children?: React.ReactNode;
}) {
  const t = useTranslations("settings.memory");
  const own = useReveal(value);
  const { shown, toggle } = reveal ?? own;
  const textId = useId();
  const scale = cn("text-sm leading-snug", className);

  if (!value.sensitive) {
    return (
      <>
        <p className={scale}>{value.text}</p>
        {children}
      </>
    );
  }

  return (
    <>
      <p className={cn("flex flex-wrap items-baseline gap-x-2", scale)}>
        <span
          id={textId}
          aria-hidden={!shown}
          className={cn("transition-[filter] motion-reduce:transition-none", !shown && "select-none blur-[5px]")}
        >
          {value.text}
        </span>
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={textId}
          onClick={toggle}
          className="shrink-0 rounded-md text-[11.5px] font-normal text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shown ? t("hide") : t("reveal")}
          {!shown && <span className="sr-only"> — {t("sensitiveBlurred")}</span>}
        </button>
      </p>
      {shown && children}
    </>
  );
}

/* WHERE `SensitiveEditNote` WENT. It explained that editing a sensitive fact would not
 * make it visible to the assistant again — true, and surprising, and worth saying while
 * the review queue offered "Edit wording" on a row that had never been saved. That
 * affordance is gone with the queue (§11.8): the archive is read-only, so there is no
 * composing surface left for the note to sit under. The underlying asymmetry has not
 * changed — sensitivity only ever rises, because `confirmClaim` ORs it in SQL — and it
 * gets its sentence back when store-only visibility earns the column of its own that
 * `memory-page.ts`'s docstring says it needs. */

/** One row. Tight on purpose: these are single sentences, and the difference between a
 *  fact and where it came from is carried by the type scale, not by padding.
 *
 *  `group/fact` is named rather than anonymous because `MemoryReview` draws its rows with
 *  this same component: an unnamed group would make a waiting row's hover reveal the
 *  delete control of whichever fact row happened to nest above it.
 *
 *  The hairline is on the ROW, not only on the card. `divide-y` sits on the outer card
 *  and separates SOURCE GROUPS, which was enough while a row was one sentence; a waiting
 *  row now carries a three-button strip, and without a boundary a group of them renders as
 *  a wall of alternating text and buttons instead of a list of decisions. A queue is
 *  worked one row at a time, so "one row" has to be something the eye can hold. First in
 *  a group takes no rule — the group's own caption is already the boundary above it. */
export function FactRow({ children }: { children: React.ReactNode }) {
  return <div className="group/fact border-t px-4 py-2 first-of-type:border-t-0">{children}</div>;
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
 * NO DIALOG, AND AN UNDO TOAST INSTEAD — the same trade the topic file's delete makes, and
 * for the same reason: a confirmation in front of every delete makes the frequent, correct
 * case tedious in order to defend against the rare mis-click, while an undo makes the
 * mis-click free and costs the correct case nothing. It became available when `restoreClaim`
 * did; before that there genuinely was no undo to offer, which is what the dialog was for.
 *
 * THE TOAST NAMES NOTHING about the fact it removed — not even a non-sensitive statement.
 * A sensitive statement in a toast is the shoulder-surfing case with no reveal control to
 * defend it, and one sentence that reads the same for every row cannot get that wrong.
 *
 * VISIBILITY, deliberately not hover-only: hover-only is unreachable by keyboard and
 * simply absent on touch. The control is always in the tab order, appears on focus, and
 * is permanently visible where there is no hover to have (`pointer-coarse`).
 */
function DeleteFact({ fact, onChanged }: { fact: FactView; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/claims/${encodeURIComponent(fact.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success(t("factDeleted"), {
        action: {
          label: t("undo"),
          onClick: () => {
            void fetch(`/api/memory/claims/${encodeURIComponent(fact.id)}`, { method: "POST" })
              // The page is re-read either way. A restore that failed leaves the fact
              // absent, and a toast is the only thing that can say so — the row it was
              // clicked from is gone by now.
              .then((r) => {
                if (!r.ok) toast.error(t("factRestoreFailed"));
              })
              .catch(() => toast.error(t("factRestoreFailed")))
              .finally(onChanged);
          },
        },
      });
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
    <button
      type="button"
      disabled={busy}
      onClick={remove}
      aria-label={t("deleteFact")}
      className={cn(
        "relative mt-0.5 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md",
        // A 28px icon inside a 40px touch target — the row is denser than a finger.
        "before:absolute before:-inset-1.5 before:content-['']",
        "text-muted-foreground hover:bg-hover hover:text-destructive",
        "opacity-0 transition-opacity motion-reduce:transition-none",
        "focus:opacity-100 group-hover/fact:opacity-100 pointer-coarse:opacity-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Trash2 aria-hidden className="size-3.5" />
    </button>
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
              disclosure of its own would put half the secret back on screen. The
              predecessor's TEXT then goes through `Statement` again, on its OWN
              sensitivity: `confirmClaim` raises a claim's flag in place without a
              supersede, so a plain fact really can have a predecessor that became
              sensitive after it was replaced. */}
          <Statement value={fact.statement}>
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
                  <div id={panelId} className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                    <p>{t("replacedOn", { date: formatDay(fact.previous.at, locale) })}</p>
                    <Statement value={fact.previous.statement} className="text-[11.5px] leading-relaxed" />
                  </div>
                )}
              </>
            )}
          </Statement>
          {/* OUTSIDE `Statement`, deliberately: its children are gated on the reveal, and
              the tag is not the secret — on a sensitive row it is the sentence that
              explains why the words above are blurred, so hiding it until they are
              readable would withhold the explanation exactly when it is needed. */}
          <TrustBadge trust={fact.trust} value={fact.statement} />
        </div>
        <DeleteFact fact={fact} onChanged={onChanged} />
      </div>
    </FactRow>
  );
}

/**
 * A LIST OF FACTS with their provenance captions — the shape both the topic detail's
 * `Related facts` and the `unfiled` list are.
 *
 * NO MATCH HIGHLIGHTING and no search: a `<mark>` inside a sensitive statement would put
 * exactly the matched words on screen in the one state whose whole purpose is that they are
 * not readable. The list is short sentences ordered by date, inside a subject the reader
 * chose to open.
 */
function FactLines({ facts, total, onChanged }: { facts: FactView[]; total: number; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const sourceText = useSourceText();
  return (
    <div className="space-y-2">
      <div className="divide-y">
        {groupBySource(facts, (f) => sourceText(f.source)).map((run) => (
          <div key={`${run.source}:${run.items[0].id}`} className="pb-1.5">
            {/* A run shares one source SENTENCE, so it shares the conversation the
                sentence names — the first item's is every item's. */}
            <SourceCaption href={chatHref(run.items[0].source)}>{run.source}</SourceCaption>
            {run.items.map((fact) => (
              <Fact key={fact.id} fact={fact} onChanged={onChanged} />
            ))}
          </div>
        ))}
      </div>
      {/* Said only when it is true. No page 2 and nothing to narrow it with: a subject with
          more than two hundred facts under it is a subject that needs splitting, which is
          the assistant's job and not a paginator's. */}
      {total > facts.length && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          {t("showingSome", { shown: facts.length, total })}
        </p>
      )}
    </div>
  );
}

/**
 * ONE TOPIC FILE AS A ROW: the title, what the file opens with, and when it last changed.
 *
 * A BUTTON and not a link, because there is no URL for a topic. That is deliberate rather
 * than lazy: an addressable `/settings/memory/<nanoid>` would put a persistent vault id in
 * the browser's history and in whatever the person pastes into a chat, and the detail view
 * is one client-side state change away. What a button owes a link is the keyboard, and it
 * has it for free.
 *
 * ONE LINE, FOUR COLUMNS: title, preview, date, chevron. A GRID rather than a stack,
 * because the three texts answer three different questions and a reader scans DOWN one
 * column at a time — which subject, what does it say, when did it change. Stacked, the same
 * three strings read as one paragraph per row and five rows read as a wall.
 *
 * `w-[calc(100%+1.5rem)]` is not a decoration and cannot be dropped for `w-full`. A
 * `<button>` is a form control: it sizes to FIT-CONTENT even with `display: grid`, so
 * without an explicit width the whole row shrink-wraps to its text and the hover surface
 * covers a narrow left column. `w-full` alone is also wrong here — with `-mx-3` the box
 * starts 12px left of the content box and would end 12px short of its right edge, so the
 * width has to carry both insets.
 *
 * TWO LINES BELOW 640px, by moving ONE cell: the date drops to row 2 and the chevron spans
 * both. Title and preview stay side by side on the first line, so the row still answers
 * "which subject, what does it say" in one glance on a phone.
 *
 * THE PREVIEW IS CLIPPED IN CSS. `truncate` lands the ellipsis at the column's real width
 * in the reader's own font; a JS slice at N characters is either short of the line or
 * spilling out of it, and it is wrong differently in every locale.
 *
 * A FILE WITH NO TEXT STILL GETS A SECOND LINE, and it says how many facts are filed under
 * it. This is not a placeholder for a missing feature — it is the honest description of the
 * five topic containers every existing account already has: `resolveTopic` mints them while
 * filing a fact and writes an EMPTY body, so the localized “Updated 30 August” line was the whole row and five
 * of them read as five identical blanks. The count is the file's actual content until the
 * agent writes prose into it, and it is a NUMBER — nothing about it can be sensitive, which
 * the first linked fact's statement (the other candidate) very much can be.
 *
 * THE DATE IS NOT ON ITS OWN COLUMN. A right-aligned stamp needs a width that fits «29
 * a long-form Ukrainian date and "29 August" alike, which on a narrow pane is width taken from the title —
 * the one thing the reader is scanning. It sits under the preview as a caption instead.
 *
 * THE HOVER IS AN INSET ROUNDED SURFACE, not a flush band. `-mx-3 px-3` is what makes both
 * halves of that true at once: the highlight is wider than the text on both sides, so no
 * glyph sits on its edge, while the text column still starts exactly where the section
 * heading above it does. The wrapper's `py-1` is what keeps the highlight off the hairlines
 * `divide-y` draws — a margin on the button itself would collapse through the wrapper and
 * change nothing. `bg-muted` rather than `bg-hover`: on the graphite palette `bg-field` is
 * the page's whitest value and a well is `bg-muted`, and a hovered row is a well.
 */
function TopicRow({ topic, onOpen }: { topic: TopicView; onOpen: () => void }) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={onOpen}
        className="group/topic -mx-3 grid w-[calc(100%+1.5rem)] grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-x-4 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto] sm:gap-x-6"
      >
        {/* Through `Statement`, like every other stored string on this page: a title is
            text somebody or something wrote, and `sensitive` has exactly one reader. */}
        <Statement value={topic.title} className="truncate font-medium" />
        {/* THE FALLBACK IS THE PREVIEW, in the preview's own column — not a third line. A
            container the agent has written no prose into yet is honestly described by how
            many facts are filed there, and that is a NUMBER: nothing about it can be
            sensitive, which the first linked fact's statement very much can be. */}
        {topic.preview.text ? (
          <Statement value={topic.preview} className="truncate text-[13px] text-muted-foreground" />
        ) : topic.factsTotal ? (
          <p className="truncate text-[13px] text-muted-foreground">
            {t("previewFactCount", { count: topic.factsTotal })}
          </p>
        ) : (
          <span />
        )}
        <p className="col-start-1 row-start-2 whitespace-nowrap text-[12.5px] text-muted-foreground sm:col-start-3 sm:row-start-1">
          {t("updatedOn", { date: formatDay(topic.updatedAt, locale) })}
        </p>
        <ChevronRight
          aria-hidden
          className="col-start-3 row-span-2 row-start-1 size-4 shrink-0 justify-self-end text-muted-foreground transition-transform motion-reduce:transition-none group-hover/topic:translate-x-0.5 sm:col-start-4 sm:row-span-1"
        />
      </button>
    </div>
  );
}

/**
 * THE LIST, grouped under its section headings.
 *
 * The ORDER is the server's — `readMemoryPage` returns (section, title) sorted — and this
 * component only inserts the headings, which is what keeps "what comes first" a single
 * answer. `TOPIC_SECTIONS` drives the loop rather than the data, so an empty section is
 * simply absent instead of a heading over nothing.
 *
 * The `satisfies` on the label map is the load-bearing part, not decoration: a fifth
 * section value is a COMPILE ERROR here rather than a heading reading
 * `settings.memory.section.thing`, which is the link `t(`section.${s}`)` would sever — the
 * union in one file, the strings in another, and nothing in between.
 */
const SECTION_KEY = {
  you: "section.you",
  topic: "section.topic",
  area: "section.area",
  person: "section.person",
} satisfies Record<TopicSection, string>;

/** The rows alone, with no headings over them — what a PROJECT's sub-group renders. Four
 *  section headings inside a project inside a "Projects" heading is three levels of nesting
 *  for a list that is usually one or two files long, so a project's files are one list and
 *  the project's own name is the heading that matters. */
export function TopicRows({ topics, onOpen }: { topics: TopicView[]; onOpen: (id: string) => void }) {
  if (!topics.length) return null;
  return (
    <SettingsGroup>
      {topics.map((topic) => (
        <TopicRow key={topic.id} topic={topic} onOpen={() => onOpen(topic.id)} />
      ))}
    </SettingsGroup>
  );
}

export function MemoryTopicList({ topics, onOpen }: { topics: TopicView[]; onOpen: (id: string) => void }) {
  const t = useTranslations("settings.memory");
  return (
    <>
      {TOPIC_SECTIONS.map((section) => {
        const rows = topics.filter((x) => x.section === section);
        if (!rows.length) return null;
        return (
          <SettingsSection key={section} title={t(SECTION_KEY[section])}>
            <TopicRows topics={rows} onOpen={onOpen} />
          </SettingsSection>
        );
      })}
    </>
  );
}

/**
 * DELETE ONE TOPIC FILE — no dialog, and an Undo toast instead.
 *
 * THAT TRADE IS THE DECISION. A modal in front of every delete makes the frequent, correct
 * case tedious in order to defend against the rare mis-click; an undo makes the mis-click
 * free and costs the correct case nothing. It is only honest because the undo genuinely
 * restores — `restoreNote` puts the node back, reopens the `contains` edges the delete
 * closed and re-projects the search document, so the file returns with its facts filed
 * where they were. A toast offering an undo that half-worked would be worse than the
 * dialog.
 *
 * The per-FACT delete next door makes the same trade, through `restoreClaim`. It used to
 * keep a dialog, because `forgetClaim` had no inverse and a control with nothing behind it
 * has to ask first; both controls now behave the same way for the same reason.
 *
 * THE TOAST NAMES NOTHING about the file it removed. A sensitive title interpolated into a
 * toast is the shoulder-surfing case with no reveal control to defend it — the same reason
 * the per-fact dialog quotes no statement.
 */
function DeleteTopic({ topic, onDeleted }: { topic: TopicView; onDeleted: () => void }) {
  const t = useTranslations("settings.memory");
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/notes/${encodeURIComponent(topic.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success(t("topicDeleted"), {
        action: {
          label: t("undo"),
          onClick: () => {
            void fetch(`/api/memory/notes/${encodeURIComponent(topic.id)}`, { method: "POST" })
              // The list is re-read either way. A restore that failed leaves the file
              // absent, and a toast is the only thing that can say so — the detail view the
              // person deleted from is gone by now.
              .then((r) => {
                if (!r.ok) toast.error(t("topicRestoreFailed"));
              })
              .catch(() => toast.error(t("topicRestoreFailed")))
              .finally(onDeleted);
          },
        },
      });
      onDeleted();
    } catch {
      toast.error(t("topicDeleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={remove}>
      {t("detailDelete")}
    </Button>
  );
}

/**
 * ONE FILE, OPEN: the way back, the title, where the file came from, Delete, the text, and
 * the facts filed here.
 *
 * THE BODY IS THE FILE'S OWN CONTENT and the page adds no headings to it. The reference
 * writes `Summary` and `Details` INSIDE the file, which is why this view has no chrome of
 * its own beyond the header strip: chrome that repeated the file's structure would compete
 * with it, and chrome that renamed it would lie about what is stored.
 *
 * RENDERED WITH THE APP'S OWN MARKDOWN COMPONENT rather than a second renderer for this
 * one surface. The body is already resolved server-side — `renderBody` turns every
 * canonical edge token into its target's current title — so what arrives here is ordinary
 * markdown with no vault vocabulary left in it.
 *
 * THE REVEAL IS SHARED with the title, through `Statement`'s own hook. A sensitive file's
 * body cannot go through `<Statement>` (that component renders a paragraph, and this is
 * markdown), so the gate is explicit here — and it is the SAME gate, not a second one,
 * which is the rule `useReveal`'s docstring exists to state.
 *
 * `Related facts` IS COLLAPSED, and its being on this screen at all is what keeps §11.9
 * true now that the page leads with files: every fact the agent writes is still visible,
 * still tagged with where it came from, and still deletable one at a time.
 */
export function MemoryTopicDetail({
  topic,
  onBack,
  onChanged,
}: {
  topic: TopicView;
  onBack: () => void;
  /** Re-read the page. Fired by a per-fact delete, and by this file's own delete/undo —
   *  whether the file is still listed is the server's decision after either. */
  onChanged: () => void;
}) {
  const t = useTranslations("settings.memory");
  const reveal = useReveal(topic.body);
  const [factsOpen, setFactsOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft aria-hidden className="size-3.5" />
        {t("detailBack")}
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          {/* THE SAME reveal the body is gated on, handed in rather than grown here: the
              title and the body carry one head revision's flag, so two controls over them
              would be two controls over one secret. */}
          <Statement value={topic.title} reveal={reveal} className="text-base font-semibold tracking-tight" />
          <TrustBadge trust={topic.trust} value={topic.title} />
        </div>
        <div className="shrink-0">
          <DeleteTopic topic={topic} onDeleted={() => { onBack(); onChanged(); }} />
        </div>
      </div>

      {topic.body.text ? (
        reveal.shown ? (
          <div className="text-[15px] leading-relaxed">
            <Markdown>{topic.body.text}</Markdown>
          </div>
        ) : (
          // The blurred-title branch already offers a reveal, and this is the same one —
          // shared state, not a second control over one secret.
          <button
            type="button"
            onClick={reveal.toggle}
            className="rounded-md text-[13px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("reveal")}
            <span className="sr-only"> — {t("sensitiveBlurred")}</span>
          </button>
        )
      ) : null}

      {!!topic.factsTotal && (
        <div>
          <button
            type="button"
            aria-expanded={factsOpen}
            aria-controls={panelId}
            onClick={() => setFactsOpen((v) => !v)}
            className="-mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3.5 transition-transform motion-reduce:transition-none", factsOpen && "rotate-90")}
            />
            {t("relatedFacts")}
            <span className="tabular-nums">{topic.factsTotal}</span>
          </button>
          {factsOpen && (
            <div id={panelId} className="mt-2 space-y-2">
              {/* Said HERE and nowhere else on the page: it explains the tag on the rows
                  directly under it, and the reader asks what a tag means at the moment they
                  first see one. */}
              <p className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">
                {t("trustExplainer")}
              </p>
              <FactLines facts={topic.facts} total={topic.factsTotal} onChanged={onChanged} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * FACTS FILED UNDER NOTHING — the guarantee, rendered.
 *
 * It is empty for this account and for every account whose facts were all written through
 * a tool: `factWrite` always resolves a topic. What produces these rows is the UNATTENDED
 * path — `runExtraction` and the legacy document migration both call `createClaim` with no
 * topic — and without a list of their own those facts would be invisible on a page whose
 * top level is topics, which is §11.9 failing at the filing seam rather than at the read.
 *
 * At the very bottom of the list and after every section, because it is the exception: a
 * person reads the four headings, and this is what did not fit under any of them.
 */
export function MemoryUnfiled({
  facts,
  total,
  onChanged,
}: {
  facts: FactView[];
  total: number;
  onChanged: () => void;
}) {
  const t = useTranslations("settings.memory");
  if (!facts.length) return null;
  return (
    <SettingsSection title={t("unfiledTitle")} description={t("unfiledHint")}>
      <FactLines facts={facts} total={total} onChanged={onChanged} />
    </SettingsSection>
  );
}
