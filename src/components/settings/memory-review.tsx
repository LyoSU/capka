"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ArchivedView, ConflictSide, ConflictView } from "@/lib/vault/memory-page";
import {
  FactRow,
  SourceCaption,
  Statement,
  TrustBadge,
  chatHref,
  formatDay,
  groupBySource,
  useReveal,
  useSourceText,
} from "./memory-topics";
import { SettingsSection } from "./shell";

/**
 * TWO SECTIONS THAT ARE BOTH DECISIONS, and they are not the same decision.
 *
 * `MemoryConflicts` is live: §4.5 step 5 stores a correction it may not apply as a claim
 * pointing at the fact it contests, and until a person answers, memory holds two facts
 * that disagree. Both are the owner's, both are already in use, and the card exists
 * because the design's answer to "I cannot tell whether this correction is the user's" is
 * a tap rather than a refusal or a silent overwrite.
 *
 * `MemoryArchive` is the retired review queue, and its whole content is history. Nothing
 * writes `memory_candidates` any more (§11.8), so this list only ever shrinks; it expires
 * thirty days after this release and the table goes with it. The copy says the date from
 * the day it appears, so the deadline is never a surprise.
 *
 * WHAT THE ARCHIVE LOST, and it is worth the sentence because deleting a working control
 * needs one. It used to offer "Edit wording", on the reasoning that a binary yes/no turns
 * every nearly-right extraction into a discard. That reasoning belonged to a queue that
 * was the ONLY way a fact could reach the assistant; extraction writes live facts now, so
 * the way to fix a nearly-right one is to edit the fact itself in the list above. A
 * composing surface on a list that expires in a month is a surface that teaches something
 * about to stop being true.
 *
 * Both render NOTHING when empty. A permanent heading over an empty box is an invitation
 * to worry about something that is not there.
 */

/** One side of a disagreement: the words, where they came from, and when.
 *
 *  Each side gets its OWN reveal, and that is the correction this file has already been
 *  through once: the two statements are different claims, `confirmClaim` can raise either
 *  one's flag in place at any time, and one control over two secrets is a way to leave
 *  half of one on screen. */
function Side({ side, keeping, onKeep }: { side: ConflictSide; keeping: boolean; onKeep: () => void }) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  const reveal = useReveal(side.statement);
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <Statement value={side.statement} reveal={reveal} />
      <TrustBadge trust={side.trust} sensitive={side.statement.sensitive} />
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {t("savedOn", { date: formatDay(side.at, locale) })}
      </p>
      <Button
        size="sm"
        variant="ghost"
        // Not disabled-because-sensitive — disabled until the words are legible, the same
        // rule the archive's edit used to hold. Keeping one fact DELETES the other, and
        // nobody can take that decision against words they cannot read.
        disabled={keeping || !reveal.shown}
        title={reveal.shown ? undefined : t("revealFirst")}
        onClick={onKeep}
      >
        {t("conflictKeepOne")}
      </Button>
    </div>
  );
}

/** One disagreement, as one card with both statements side by side. */
function Conflict({ conflict, onChanged }: { conflict: ConflictView; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const [busy, setBusy] = useState(false);

  const resolve = async (keep: "both" | "this" | "other") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/claims/${encodeURIComponent(conflict.claim.id)}/conflict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep }),
      });
      // 404 is "this disagreement is no longer open" — answered in another tab, or one of
      // the two facts deleted from the list above. Re-read as well as complain: without
      // it the card stays on screen and every further click fails the same way.
      if (res.status === 404) {
        toast.error(t("decideFailed"));
        onChanged();
        return;
      }
      if (!res.ok) throw new Error();
      onChanged();
    } catch {
      toast.error(t("decideFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FactRow>
      {/* Side by side on a wide screen, stacked on a narrow one. The rule between them is
          what says "these two are one question" — the alternative, two ordinary rows, is
          exactly the flattening that makes a disagreement invisible. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
        <Side side={conflict.claim} keeping={busy} onKeep={() => resolve("this")} />
        <div aria-hidden className="hidden w-px shrink-0 self-stretch bg-border sm:block" />
        <Side side={conflict.contested} keeping={busy} onKeep={() => resolve("other")} />
      </div>
      <div className="mt-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => resolve("both")}>
          {t("conflictKeepBoth")}
        </Button>
      </div>
    </FactRow>
  );
}

export function MemoryConflicts({ conflicts, onChanged }: { conflicts: ConflictView[]; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  if (!conflicts.length) return null;

  return (
    <SettingsSection title={t("conflictTitle")} description={t("conflictHint")}>
      <div className="divide-y overflow-hidden rounded-xl bg-card shadow-panel">
        {conflicts.map((c) => (
          <Conflict key={c.claim.id} conflict={c} onChanged={onChanged} />
        ))}
      </div>
    </SettingsSection>
  );
}

/** One archived suggestion, and the two things left to do with it. */
function Suggestion({ item, onChanged }: { item: ArchivedView; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const reveal = useReveal(item.statement);

  const decide = async (decision: "confirm" | "reject") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/candidates/${encodeURIComponent(item.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      // 409 is live contention for this fact's slot — a real "come back in a moment", and
      // the row stays exactly where it is so the person can.
      if (res.status === 409) {
        toast.error(t("tryAgain"));
        return;
      }
      // 404 is "this row is no longer open" — decided in another tab, or swept by a
      // reset. Re-read as well as complain: without it the row stays on screen and every
      // further click fails the same way, which is the button-that-does-nothing the whole
      // amendment was written about.
      if (res.status === 404) {
        toast.error(t("decideFailed"));
        onChanged();
        return;
      }
      if (!res.ok) throw new Error();
      // Re-read rather than splicing locally: a keep writes a real fact into the list
      // above and can empty this section entirely, and the server decides which.
      onChanged();
    } catch {
      toast.error(t("decideFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FactRow>
      <Statement value={item.statement} reveal={reveal}>
        {item.state === "conflict" && (
          <div className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warning-text">
            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning-text" />
            {/* The other half, or the bare word when the ledger recorded a contested
                slot with no head left to point at. Keeping this SUPERSEDES that, so
                the sentence says so rather than leaving the reader to guess.
                The head's TEXT goes through `Statement` on its own sensitivity: this
                is a different claim from the suggestion, and `confirmClaim` can raise
                its flag in place at any time — printing it interpolated into the
                sentence rendered a sensitive head in full, two rows under the
                identical words rendered blurred. */}
            {item.conflictsWith ? (
              <div className="min-w-0">
                <p>{t("conflictReplacesOn", { date: formatDay(item.conflictsWith.at, locale) })}</p>
                <Statement value={item.conflictsWith.statement} className="text-[11.5px] leading-relaxed" />
              </div>
            ) : (
              <p>{t("reviewConflict")}</p>
            )}
          </div>
        )}
      </Statement>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !reveal.shown} title={reveal.shown ? undefined : t("revealFirst")} onClick={() => decide("confirm")}>
          {t("confirm")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide("reject")}>
          {t("reject")}
        </Button>
      </div>
    </FactRow>
  );
}

export function MemoryArchive({ archive, expiresAt, onChanged }: {
  archive: ArchivedView[];
  /** The one date this section promises, ISO, from the server — see `archiveExpiresAt`. */
  expiresAt: string;
  onChanged: () => void;
}) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  const sourceText = useSourceText();
  if (!archive.length) return null;

  return (
    <SettingsSection
      title={t("archiveTitle")}
      description={t("archiveHint", { date: formatDay(expiresAt, locale) })}
    >
      <div className="divide-y overflow-hidden rounded-xl bg-card shadow-panel">
        {groupBySource(archive, (p) => sourceText(p.source)).map((run) => (
          <div key={`${run.source}:${run.items[0].id}`} className="pb-1.5">
            {/* A link, for the reader who does not recognise a suggestion and wants to go
                and read what they actually said before deciding. */}
            <SourceCaption href={chatHref(run.items[0].source)}>{run.source}</SourceCaption>
            {run.items.map((item) => (
              <Suggestion key={item.id} item={item} onChanged={onChanged} />
            ))}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
