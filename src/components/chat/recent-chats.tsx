"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { MessageSquare } from "lucide-react";

interface ChatRow {
  id: string;
  title: string | null;
  updatedAt: string | null;
}

/** Quick-resume list of the user's most recent chats on the empty home screen. */
export function RecentChats() {
  const t = useTranslations("chat.panel");
  const tn = useTranslations("nav");
  const locale = useLocale();
  const [chats, setChats] = useState<ChatRow[] | null>(null);

  useEffect(() => {
    fetch("/api/chats")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ChatRow[]) => setChats(rows.slice(0, 4)))
      .catch(() => setChats([]));
  }, []);

  if (!chats || chats.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("recent")}</p>
      <div className="overflow-hidden rounded-xl border">
        {chats.map((c, i) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm transition-colors hover:bg-muted/60 ${
              i > 0 ? "border-t" : ""
            }`}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{c.title || tn("newChat")}</span>
            </span>
            {c.updatedAt && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(c.updatedAt).toLocaleDateString(locale, { month: "short", day: "numeric" })}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
