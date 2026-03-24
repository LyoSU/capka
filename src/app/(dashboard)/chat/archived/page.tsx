"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArrowLeft, Trash2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/layout/header";

type ArchivedChat = {
  id: string;
  title: string | null;
  updatedAt: string | null;
};

export default function ArchivedChatsPage() {
  const router = useRouter();
  const [chats, setChats] = useState<ArchivedChat[]>([]);

  const fetchArchived = useCallback(() => {
    fetch("/api/chats?archived=true")
      .then((r) => (r.ok ? r.json() : []))
      .then(setChats)
      .catch(() => {});
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
    fetchArchived();
  }

  return (
    <>
      <Header title="Archived Chats" />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          <Link
            href="/chat"
            className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to chats
          </Link>

          {chats.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Archive className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No archived chats</p>
            </div>
          ) : (
            <div className="space-y-1">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className="group flex items-center gap-3 rounded-lg border px-4 py-3"
                >
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    onClick={() => router.push(`/chat/${chat.id}`)}
                  >
                    <p className="truncate text-sm font-medium">
                      {chat.title || "New Chat"}
                    </p>
                    {chat.updatedAt && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(chat.updatedAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => unarchive(chat.id)}
                      title="Unarchive"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => deleteChat(chat.id)}
                      title="Delete permanently"
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
    </>
  );
}
