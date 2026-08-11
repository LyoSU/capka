"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Archive, ArrowLeft, Trash2, RotateCcw, RotateCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/layout/header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";

type ArchivedChat = {
  id: string;
  title: string | null;
  updatedAt: string | null;
};

export default function ArchivedChatsPage() {
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [chats, setChats] = useState<ArchivedChat[]>([]);
  // "Nothing archived" and "couldn't load" used to render as the same sentence,
  // which told a user whose archive still exists that it was empty.
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchArchived = useCallback(() => {
    fetch("/api/chats?archived=true")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((rows) => {
        setChats(rows);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  useEffect(() => {
    fetchArchived();
  }, [fetchArchived]);

  async function unarchive(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      // Unchecked before: a failed restore left the row exactly where it was,
      // which is indistinguishable from a successful one that hadn't refreshed.
      if (!res.ok) throw new Error(String(res.status));
      fetchArchived();
    } catch {
      toast.error(t("archived.restoreFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteChat(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      setDeleteId(null);
      fetchArchived();
    } catch {
      toast.error(t("archived.deleteFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Header title={t("archived.title")} />
      <div className="flex-1 overflow-y-auto p-6 [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-2xl">
          <Link
            href="/chat"
            className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("archived.back")}
          </Link>

          {state === "loading" ? (
            <div className="divide-y overflow-hidden rounded-xl border bg-card" aria-hidden>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="space-y-2 px-4 py-3.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </div>
          ) : state === "error" ? (
            <EmptyState icon={Archive} title={t("archived.loadError")} hint={t("archived.loadErrorHint")} className="py-16">
              <Button variant="outline" size="sm" onClick={() => { setState("loading"); fetchArchived(); }}>
                <RotateCw className="h-4 w-4" />
                {tc("retry")}
              </Button>
            </EmptyState>
          ) : chats.length === 0 ? (
            <EmptyState icon={Archive} title={t("archived.empty")} hint={t("archived.emptyHint")} className="py-16">
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/chat" />}>
                {t("archived.back")}
              </Button>
            </EmptyState>
          ) : (
            /* One grouped card with hairlines, like the projects list — eight
               separately bordered rows read as eight unrelated things. */
            <div className="divide-y overflow-hidden rounded-xl border bg-card">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
                >
                  <Link href={`/chat/${chat.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {chat.title || t("untitled")}
                    </p>
                    {chat.updatedAt && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(chat.updatedAt).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    )}
                  </Link>
                  {/* focus-within is load-bearing, not decoration: without it a
                      keyboard user tabbed into two fully invisible buttons, one of
                      which deletes the chat for good. */}
                  <div className="flex shrink-0 gap-1 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={busyId === chat.id}
                      onClick={() => unarchive(chat.id)}
                      aria-label={t("archived.restore")}
                      title={t("archived.restore")}
                    >
                      {busyId === chat.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      disabled={busyId === chat.id}
                      onClick={() => setDeleteId(chat.id)}
                      aria-label={t("archived.delete")}
                      title={t("archived.delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={() => deleteId && deleteChat(deleteId)}
        title={t("archived.confirmTitle")}
        description={t("archived.confirmDescription")}
      />
    </>
  );
}
