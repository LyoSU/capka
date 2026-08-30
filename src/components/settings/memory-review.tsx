"use client";

import { useTranslations } from "next-intl";
import type { PendingView } from "@/lib/vault/memory-page";
import {
  FactRow,
  SensitiveStatement,
  SourceCaption,
  groupBySource,
  useSourceText,
} from "./memory-topics";
import { SettingsSection } from "./shell";

/**
 * The facts the assistant noticed but is not using.
 *
 * THE COPY DESCRIBES THE PRESENT, and that is a correction rather than a style choice.
 * The first draft said the reader "will be able to keep or discard each one here" — a
 * future-tense promise on a screen with no buttons on it, which sent the maintainer
 * hunting for a control and concluding the page was broken. Keep is Task 8 and delete is
 * Task 2; until they exist the honest thing to say is what is true now: these are set
 * aside and inert. A sentence that needs "will" is describing a different release, and
 * the fix is to ship the release, not to write the sentence.
 *
 * THE LOOK IS THE SAME LIST AS THE FACTS ABOVE — one quiet card, hairline rows — for the
 * same reason. Giving every waiting fact an amber fill and a dashed border turned eleven
 * ordinary sentences into eleven alerts; "waiting" is said once, by this section's own
 * heading. The only per-row mark left is the dot on a CONFLICT, which is the one row
 * that genuinely differs from its neighbours.
 *
 * Renders NOTHING when the list is empty: a permanent "set aside" heading over an empty
 * box is an invitation to worry about something that is not there.
 */
export function MemoryReview({ pending }: { pending: PendingView[] }) {
  const t = useTranslations("settings.memory");
  const sourceText = useSourceText();
  if (!pending.length) return null;

  return (
    <SettingsSection title={t("reviewTitle")} description={t("reviewHint")}>
      <div className="divide-y overflow-hidden rounded-xl bg-card shadow-panel">
        {groupBySource(pending, (p) => sourceText(p.source)).map((run) => (
          <div key={`${run.source}:${run.items[0].id}`} className="pb-1.5">
            <SourceCaption>{run.source}</SourceCaption>
            {run.items.map((item) => (
              <FactRow key={item.id}>
                {item.sensitive ? (
                  <SensitiveStatement />
                ) : (
                  <p className="text-sm leading-snug">{item.statement}</p>
                )}
                {item.state === "conflict" && (
                  <p className="mt-1 flex items-center gap-1.5 text-[11.5px] leading-relaxed text-warning-text">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning-text" />
                    {t("reviewConflict")}
                  </p>
                )}
              </FactRow>
            ))}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
