"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { ChatMessage } from "@/components/chat/message";
import { ClawMark } from "@/components/brand/claw-mark";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

/**
 * Read-only render of a published conversation. Reuses ChatMessage with no
 * interaction handlers and no chatId — which disables editing, forking,
 * attachment tiles and workspace-link resolution by construction, so nothing
 * here can reach the owner's authed endpoints. A signed-in visitor gets a
 * "clone into my account" action; everyone else gets a sign-in prompt.
 */
export function SharedChatView({
  title,
  token,
  messages,
  canClone,
}: {
  title: string | null;
  token: string;
  messages: unknown[];
  canClone: boolean;
}) {
  const t = useTranslations("chat.share");
  const tc = useTranslations("chat");
  const router = useRouter();
  const [cloning, setCloning] = useState(false);

  async function clone() {
    setCloning(true);
    try {
      const res = await fetch("/api/chats/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error("clone failed");
      const { id } = (await res.json()) as { id: string };
      router.push(`/chat/${id}`);
    } catch {
      toast.error(t("cloneFailed"));
      setCloning(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background/80 px-4 py-3 backdrop-blur">
        <Link href="/" aria-label="Capka" className="shrink-0 text-foreground">
          <ClawMark className="size-6" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{title || tc("untitled")}</h1>
          <p className="text-xs text-muted-foreground">{t("readOnly")}</p>
        </div>
        {canClone ? (
          <Button size="sm" onClick={clone} disabled={cloning}>
            {cloning ? t("cloning") : t("clone")}
          </Button>
        ) : (
          <Link href="/login" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            {t("signInToClone")}
          </Link>
        )}
      </header>

      <main className="flex-1 overflow-y-auto pb-24 pt-6 [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-3xl px-2 md:px-4 lg:max-w-4xl">
          {messages.map((m) => {
            const msg = m as { id: string; role: string };
            return (
              <div key={msg.id} data-role={msg.role}>
                <ChatMessage message={msg as never} />
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
