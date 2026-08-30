"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { PendingView } from "@/lib/vault/memory-page";
import {
  FactRow,
  SensitiveEditNote,
  SourceCaption,
  Statement,
  chatHref,
  formatDay,
  groupBySource,
  useReveal,
  useSourceText,
} from "./memory-topics";
import { SettingsSection } from "./shell";

/**
 * The facts the assistant noticed but is not using — and the decision on each of them.
 *
 * THE COPY DESCRIBES THE PRESENT. It said the reader "will be able to keep or discard
 * each one here" while the section had no buttons on it, which sent the maintainer
 * hunting for a control and concluding the page was broken; the fix recorded then was to
 * ship the release rather than reword the sentence, and this is that release. The tense
 * is present because the controls are now here.
 *
 * THE LOOK IS THE SAME LIST AS THE FACTS ABOVE — one quiet card, hairline rows. Giving
 * every waiting fact an amber fill and a dashed border turned eleven ordinary sentences
 * into eleven alerts; "waiting" is said once, by this section's own heading. The only
 * per-row mark left is on a CONFLICT, which is the one row that genuinely differs from
 * its neighbours — and it now says what it conflicts WITH, because "this disagrees with
 * something already remembered" is a word, not a choice.
 *
 * THE CONTROLS ARE ALWAYS VISIBLE, unlike the delete on a saved fact. They are the point
 * of the section rather than a secondary action on a row that is otherwise fine, and a
 * queue whose whole purpose is to be worked through must not make the reader hover to
 * find out how. The one revealed affordance here is the blur over a sensitive statement,
 * and that reveals TEXT — it gates nothing.
 *
 * Renders NOTHING when the list is empty: a permanent "set aside" heading over an empty
 * box is an invitation to worry about something that is not there.
 */

/** One waiting fact, and what can be done about it.
 *
 *  EDITING IS AN AFFORDANCE, NOT A LIVE TEXTAREA. The common action is agreeing with what
 *  is there; a row that opens as an input asks every reader to compose where almost all of
 *  them only wanted to confirm. But it has to exist at all, because a binary yes/no turns
 *  every nearly-right extraction into a discard — and with the extractor's quality still
 *  unmeasured, "nearly right" is the common case rather than the edge. Without it the
 *  queue teaches the person to throw good facts away.
 *
 *  The server treats an edited statement as the PERSON's words, provenance included. That
 *  is what makes offering this safe rather than merely convenient.
 *
 *  ON A SENSITIVE ROW, EDIT WAITS FOR THE REVEAL. A textarea holding the raw text was a
 *  second entrance to the very rule the blur exists for: one click on a button labelled
 *  "Edit wording" put the words on screen, and "Edit wording" does not read as "show me
 *  the secret". The reveal control is where exposure is asked for, so the row shares its
 *  state (`useReveal`) rather than growing a second copy of the rule — this component
 *  never reads `sensitive` and could not act on it if it wanted to. */
function Waiting({ item, onChanged }: { item: PendingView; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const reveal = useReveal(item.statement);

  const decide = async (decision: "confirm" | "reject", statement?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/candidates/${encodeURIComponent(item.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(statement === undefined ? { decision } : { decision, statement }),
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
      setDraft(null);
      // Re-read rather than splicing locally: a confirm can supersede a saved fact, empty
      // a topic or close the whole section, and the server is what decides which.
      onChanged();
    } catch {
      toast.error(t("decideFailed"));
    } finally {
      setBusy(false);
    }
  };

  const editing = draft !== null;

  return (
    <FactRow>
      {editing ? (
        <div className="space-y-2">
          <label className="block text-[11.5px] text-muted-foreground" htmlFor={`edit-${item.id}`}>
            {t("editLabel")}
          </label>
          <Textarea
            id={`edit-${item.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            className="min-h-14"
          />
          <SensitiveEditNote value={item.statement} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || draft.trim().length < 3}
              onClick={() => decide("confirm", draft.trim())}
            >
              {t("editSave")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              {t("editCancel")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Statement value={item.statement} reveal={reveal}>
            {item.state === "conflict" && (
              <div className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warning-text">
                <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning-text" />
                {/* The other half, or the bare word when the ledger recorded a contested
                    slot with no head left to point at. Keeping this SUPERSEDES that, so
                    the sentence says so rather than leaving the reader to guess.
                    The head's TEXT goes through `Statement` on its own sensitivity: this
                    is a different claim from the candidate, and `confirmClaim` can raise
                    its flag in place at any time — printing it interpolated into the
                    sentence rendered a sensitive head in full, two rows under the
                    identical words rendered blurred. */}
                {item.conflictsWith ? (
                  <div className="min-w-0">
                    <p>{t("conflictReplacesOn", { date: formatDay(item.conflictsWith.at, locale) })}</p>
                    <Statement
                      value={item.conflictsWith.statement}
                      className="text-[11.5px] leading-relaxed"
                    />
                  </div>
                ) : (
                  <p>{t("reviewConflict")}</p>
                )}
              </div>
            )}
          </Statement>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => decide("confirm")}>
              {t("confirm")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide("reject")}>
              {t("reject")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              // Not disabled-because-sensitive — disabled until the words are legible. The
              // row never asks which; `useReveal` answers `shown: true` for every ordinary
              // fact, so this reads as one rule and not as a special case.
              disabled={busy || !reveal.shown}
              title={reveal.shown ? undefined : t("editNeedsReveal")}
              onClick={() => setDraft(item.statement.text)}
            >
              {t("editStatement")}
            </Button>
          </div>
        </>
      )}
    </FactRow>
  );
}

export function MemoryReview({ pending, onChanged }: { pending: PendingView[]; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const sourceText = useSourceText();
  if (!pending.length) return null;

  return (
    <SettingsSection title={t("reviewTitle")} description={t("reviewHint")}>
      <div className="divide-y overflow-hidden rounded-xl bg-card shadow-panel">
        {groupBySource(pending, (p) => sourceText(p.source)).map((run) => (
          <div key={`${run.source}:${run.items[0].id}`} className="pb-1.5">
            {/* A link, for the reader who does not recognise a fact and wants to go and
                read what they actually said before deciding. */}
            <SourceCaption href={chatHref(run.items[0].source)}>{run.source}</SourceCaption>
            {run.items.map((item) => (
              <Waiting key={item.id} item={item} onChanged={onChanged} />
            ))}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
