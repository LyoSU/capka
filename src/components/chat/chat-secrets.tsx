"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { KeyRound, Loader2, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type StoredSecret = { name: string };

/**
 * A place to hand the assistant a password or an API key for THIS chat.
 *
 * The value goes straight to the server and never comes back: it is stored encrypted,
 * set as an environment variable inside this chat's sandbox, and stripped out of any
 * command output before the assistant reads it. That is why this control shows a list
 * of NAMES with no reveal affordance anywhere — there is nothing to reveal, and an
 * "eye" icon would promise otherwise.
 *
 * The field is cleared the moment a save succeeds, so a shoulder-surfer or a screen
 * share sees an empty box rather than a credential parked in the DOM.
 */
export function ChatSecrets({ chatId, ensureChat }: { chatId: string; ensureChat: () => Promise<void> }) {
  const t = useTranslations("chat.secrets");
  const [open, setOpen] = useState(false);
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
      // Offline or a dropped request: the badge simply doesn't appear. Nothing the
      // person can act on, so nothing is said.
    }
  }, [chatId]);

  // Once on mount, because the dot on the trigger has to be right before anyone
  // opens it, and again whenever the popover opens so a second tab's change shows.
  useEffect(() => { void load(); }, [load]);

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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
        // Never leave a typed credential sitting in state behind a closed popover.
        else setValue("");
      }}
    >
      <PopoverTrigger
        aria-label={t("label")}
        className="relative flex h-9 items-center rounded-full px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-popup-open:text-foreground"
      >
        <KeyRound className="h-4 w-4" aria-hidden />
        {secrets.length > 0 && (
          // A dot, not a count: "you have credentials here" is the whole message, and
          // a number invites the reader to wonder which ones.
          <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </PopoverTrigger>

      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-3">
        <p className="text-sm font-medium text-foreground">{t("title")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("hint")}</p>

        {secrets.length > 0 && (
          <ul className="mt-3 space-y-1">
            {secrets.map((s) => (
              <li key={s.name} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm">
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

        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
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
          <Button type="submit" size="sm" className="w-full" disabled={busy || !name.trim() || !value}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("save")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
