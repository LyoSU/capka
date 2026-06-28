"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Archive, ArrowLeft, Trash2, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/layout/header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

type ArchivedChat = {
  id: string;
  title: string | null;
  updatedAt: string | null;
};

export default function ArchivedChatsPage() {
  const t = useTranslations("chat");
  const [chats, setChats] = useState<ArchivedChat[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchArchived = useCallback(() => {
    fetch("/api/chats?archived=true")
      .then((r) => (r.ok ? r.json() : []))
      .then(setChats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchArchived();
  }, [fetchArchived]);

  async function unarchive(id: string) {
    await fetch(`/api/chats/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    fetchArchived();
  }

  async function deleteChat(id: string) {
    await fetch(`/api/chats/${id}`, { method: "DELETE" });
    setDeleteId(null);
    fetchArchived();
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

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : chats.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50">
                <Archive className="h-6 w-6 text-muted-foreground/40" />
              </div>
              <p className="text-sm text-muted-foreground">{t("archived.empty")}</p>
            </div>
          ) : (
            <div className="space-y-1">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className="group flex items-center gap-3 rounded-lg border px-4 py-3"
                >
                  <Link
                    href={`/chat/${chat.id}`}
                    className="min-w-0 flex-1"
                  >
                    <p className="truncate text-sm font-medium">
                      {chat.title || t("untitled")}
                    </p>
                    {chat.updatedAt && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(chat.updatedAt).toLocaleDateString()}
                      </p>
                    )}
                  </Link>
                  <div className="flex shrink-0 gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => unarchive(chat.id)}
                      aria-label={t("archived.restore")}
                      title={t("archived.restore")}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
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
