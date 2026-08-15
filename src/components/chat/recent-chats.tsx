"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";

interface ChatRow {
  id: string;
  title: string | null;
  updatedAt: string | null;
}

/** "today" / "yesterday" / "3 days ago", then a plain date once the relative form
 *  stops being the more useful one. A column of four identical "15 Aug"s is a
 *  column carrying no information — the relative form is what actually tells the
 *  rows apart, and `numeric: "auto"` gives the localized word rather than "0 days
 *  ago". */
function whenLabel(iso: string, locale: string): string {
  const date = new Date(iso);
  const days = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (days < 7) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day");
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** Quick-resume list of the user's most recent chats on the empty home screen.
 *  `initial` is the server-rendered list (from the chat page) so the section is
 *  correct on first paint and never pops in late — only when it's omitted do we
 *  fall back to a client fetch. */
export function RecentChats({ initial }: { initial?: ChatRow[] }) {
  const t = useTranslations("chat.panel");
  const tn = useTranslations("nav");
  const locale = useLocale();
  const [chats, setChats] = useState<ChatRow[] | null>(initial ?? null);

  useEffect(() => {
    if (initial) return; // seeded from the server — no client flash/jump
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ChatRow[]) => setChats(rows.slice(0, 4)))
      .catch(() => setChats([]));
  }, [initial]);

  if (!chats || chats.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-sm text-muted-foreground">{t("recent")}</h2>
      <div className="overflow-hidden rounded-xl border">
        {chats.map((c, i) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            // Neither a hover shadow nor a press scale: the row sits inside an
            // `overflow-hidden` container and spans its full width, so a lift was
            // clipped into a dark smear, and a 1% shrink pulled the row's fill
            // several pixels clear of the rounded frame on each side — it read as
            // a cropped rectangle rather than as a press. `--hover-strong` is the
            // pressed step above `--hover`, and it costs the row no geometry.
            className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm transition-micro hover:bg-hover active:bg-hover-strong ${
              i > 0 ? "border-t" : ""
            }`}
          >
            {/* No leading icon. The same glyph on every row distinguishes nothing
                — it only indents the one thing the eye is here for, the title. */}
            <span className="truncate">{c.title || tn("newChat")}</span>
            {c.updatedAt && (
              <span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>
                {whenLabel(c.updatedAt, locale)}
              </span>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
