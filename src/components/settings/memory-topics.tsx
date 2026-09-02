"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { FactSource, FactView, StatementView, TrustTag } from "@/lib/vault/memory-page";

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
 * ONE list of everything the person has approved in this scope, newest first.
 *
 * IT REPLACES A TOPIC RAIL, and the rail is worth a sentence because deleting a working
 * control needs one. It was a real tablist, keyboard-navigable, with a last-updated stamp
 * under each name — and it was a filing system nothing files into. Every live write path
 * passes one topic key; the other four entries were leftovers from a vocabulary that was
 * later narrowed, frozen since August, and rendering in English to a Ukrainian reader
 * because only the one live key had copy. The cost was not that it looked untidy: with one
 * topic selected at a time it put 33 of this account's 51 approved facts on screen and left
 * the other 18 behind buttons nobody had a reason to press. A person's own confirmed fact
 * that they cannot find reads as a fact the assistant lost.
 *
 * So there is no grouping control here, and the copy above the list says grouping does not
 * exist yet rather than implying it does. Subject-based topics — a project, a person, a
 * document, named in the user's own words — are a later design with their own identity
 * model, not this rail with better labels.
 *
 * NO MATCH HIGHLIGHTING, deliberately, and this is the one search convention worth
 * refusing. A `<mark>` inside a sensitive statement would put exactly the matched words on
 * screen in the one state whose whole purpose is that they are not readable — the blur
 * defeated by the feature meant to help read past it. The list is short sentences ordered
 * by date; a person finds their row without a yellow band on it.
 */
export function MemoryFacts({
  facts,
  matched,
  onChanged,
}: {
  facts: FactView[];
  /** How many matched before the server's cap — `facts` may be a prefix of them. */
  matched: number;
  onChanged: () => void;
}) {
  const t = useTranslations("settings.memory");
  const sourceText = useSourceText();
  if (!facts.length) return null;

  return (
    <div className="space-y-2">
      <FactList>
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
      </FactList>
      {/* Said only when it is true, and it points at the search box rather than offering
          a page 2: a person looking for one fact among thousands reaches for words. */}
      {matched > facts.length && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          {t("showingSome", { shown: facts.length, total: matched })}
        </p>
      )}
    </div>
  );
}
