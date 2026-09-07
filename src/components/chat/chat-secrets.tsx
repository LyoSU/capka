"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type StoredSecret = { name: string };

/**
 * A place to hand the assistant a password or an API key for THIS chat. Opened
 * from the composer's "+" menu; the dialog owns no trigger of its own.
 *
 * The value goes straight to the server and never comes back: it is stored encrypted,
 * set as an environment variable inside this chat's sandbox, and stripped out of any
 * command output before the assistant reads it. That is why this dialog shows a list
 * of NAMES with no reveal affordance anywhere — there is nothing to reveal, and an
 * "eye" icon would promise otherwise.
 *
 * The field is cleared the moment a save succeeds, and again when the dialog closes,
 * so a shoulder-surfer or a screen share sees an empty box rather than a credential
 * parked in the DOM.
 */
export function ChatSecrets({
  chatId,
  ensureChat,
  open,
  onOpenChange,
}: {
  chatId: string;
  ensureChat: () => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("chat.secrets");
  const [secrets, setSecrets] = useState<StoredSecret[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats/${chatId}/secrets`);
      // 404 is the ordinary state of a chat that has not been sent a message yet —
      // the row is created on the first send (or by `ensureChat` below), so an empty
      // list is the honest answer rather than an error worth showing anyone.
      if (res.status === 404) return setSecrets([]);
      if (!res.ok) return;
      const data = (await res.json()) as { secrets: StoredSecret[] };
      setSecrets(data.secrets ?? []);
    } catch {
      // Offline or a dropped request: the list simply stays as it was. Nothing the
      // person can act on, so nothing is said.
    }
  }, [chatId]);

  // Fetched on every open, not once: a second tab may have added or removed one.
  useEffect(() => {
    if (open) void load();
    else setValue("");
  }, [open, load]);

  const save = async () => {
    if (!name.trim() || !value) return;
    setBusy(true);
    try {
      // A fresh chat has no row yet, and a credential is a perfectly ordinary first
      // thing to set up — the same reason uploads and folder syncs call this.
      await ensureChat();
      const res = await fetch(`/api/chats/${chatId}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        toast.error(data.code === "BAD_NAME" ? t("nameInvalid") : t("saveFailed"));
        return;
      }
      setName("");
      setValue("");
      await load();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secretName: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/chats/${chatId}/secrets`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: secretName }),
      });
      if (!res.ok) return toast.error(t("removeFailed"));
      await load();
    } catch {
      toast.error(t("removeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("hint")}</DialogDescription>
        </DialogHeader>

        {secrets.length > 0 && (
          <ul className="space-y-1">
            {secrets.map((s) => (
              <li key={s.name} className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span className="flex-1 truncate font-mono text-xs text-foreground">{s.name}</span>
                <button
                  type="button"
                  onClick={() => remove(s.name)}
                  disabled={busy}
                  aria-label={t("remove", { name: s.name })}
                  className="text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            aria-label={t("namePlaceholder")}
            autoComplete="off"
            disabled={busy}
          />
          <Input
            // `type="password"` and no autofill: the browser must not offer to save
            // this, and it must not be readable over a shoulder while it is typed.
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("valuePlaceholder")}
            aria-label={t("valuePlaceholder")}
            autoComplete="new-password"
            disabled={busy}
          />
          <Button type="submit" className="w-full" disabled={busy || !name.trim() || !value}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("save")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
