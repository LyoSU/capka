"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Pin,
  PinOff,
  Archive,
  Pencil,
  Trash2,
  Download,
  MoreVertical,
  Share2,
  Lock,
  Globe,
  Users,
  Copy,
  Check,
} from "lucide-react";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ActionMenu, type ActionItem } from "@/components/ui/action-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type ChatItem = {
  id: string;
  title: string | null;
  pinned: boolean | null;
  archived: boolean | null;
  visibility?: string | null;
  shareToken?: string | null;
};

type Visibility = "private" | "link" | "users";

export function ChatContextMenu({
  chat,
  onUpdate,
  children,
  open,
  onOpenChange,
}: {
  chat: ChatItem;
  onUpdate: () => void;
  children: React.ReactNode;
  // The menu's open state can be driven from the row (a long-press on touch,
  // where the visible ⋮ trigger is hidden). Falls back to internal state so the
  // component still works uncontrolled.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const t = useTranslations("chat");
  const tc = useTranslations("common");
  const [internalOpen, setInternalOpen] = useState(false);
  const menuOpen = open ?? internalOpen;
  const setMenuOpen = onOpenChange ?? setInternalOpen;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>(
    (chat.visibility as Visibility) ?? "private",
  );
  const [shareToken, setShareToken] = useState<string | null>(chat.shareToken ?? null);
  const [copied, setCopied] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);

  const shareUrl =
    shareToken && typeof window !== "undefined"
      ? `${window.location.origin}/share/${shareToken}`
      : "";

  async function patchChat(data: Record<string, unknown>) {
    await fetch(`/api/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    onUpdate();
  }

  // Publish/unpublish. The PATCH mints (and returns) a stable share token the
  // first time the chat is shared, so we adopt whatever the server settles on
  // rather than guessing the URL client-side.
  async function changeVisibility(next: Visibility) {
    const previous = visibility;
    setSavingVisibility(true);
    setVisibility(next);
    try {
      const res = await fetch(`/api/chats/${chat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) throw new Error("visibility update failed");
      const data = (await res.json()) as { visibility?: Visibility; shareToken?: string | null };
      if (data.visibility) setVisibility(data.visibility);
      if (data.shareToken) setShareToken(data.shareToken);
      onUpdate();
    } catch {
      setVisibility(previous);
      toast.error(t("share.updateFailed"));
    } finally {
      setSavingVisibility(false);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    toast.success(t("share.copied"));
    setTimeout(() => setCopied(false), 2000);
  }

  async function deleteChat() {
    await fetch(`/api/chats/${chat.id}`, { method: "DELETE" });
    setDeleteOpen(false);
    onUpdate();
    router.push("/chat");
  }

  function startRename() {
    setRenameValue(chat.title || "");
    setRenaming(true);
  }

  async function submitRename() {
    if (!renaming) return;
    setRenaming(false);
    if (renameValue.trim() && renameValue !== chat.title) {
      await patchChat({ title: renameValue.trim() });
    }
  }

  if (renaming) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitRename();
        }}
        className="w-full px-1"
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === "Escape") setRenaming(false);
          }}
          className="h-6 px-1.5 text-base md:text-sm"
          autoFocus
        />
      </form>
    );
  }

  const items: ActionItem[] = [
    { key: "rename", icon: <Pencil />, label: t("menu.rename"), onSelect: startRename },
    {
      key: "pin",
      icon: chat.pinned ? <PinOff /> : <Pin />,
      label: chat.pinned ? t("menu.unpin") : t("menu.pin"),
      onSelect: () => patchChat({ pinned: !chat.pinned }),
    },
    {
      key: "archive",
      icon: <Archive />,
      label: chat.archived ? t("menu.unarchive") : t("menu.archive"),
      onSelect: () => patchChat({ archived: !chat.archived }),
    },
    {
      key: "export",
      icon: <Download />,
      label: t("menu.export"),
      onSelect: () => window.open(`/api/chats/${chat.id}/export?format=markdown`, "_blank"),
    },
    { key: "share", icon: <Share2 />, label: t("menu.share"), onSelect: () => setShareOpen(true) },
    {
      key: "delete",
      icon: <Trash2 />,
      label: tc("delete"),
      variant: "destructive",
      onSelect: () => setDeleteOpen(true),
    },
  ];

  return (
    <>
      {children}
      <ActionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={chat.title || t("untitled")}
        ariaLabel={t("menu.options")}
        items={items}
        contentProps={{ side: "right", align: "start", sideOffset: 8, className: "w-auto" }}
      >
        {/* Invisible anchor: keeps the desktop popover positioned even when the
            visible ⋮ trigger is hidden on touch, and lets a long-press open it
            (via the controlled `open`) with no tap target of its own.
            pointer-events-none so a normal tap never opens it. */}
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          nativeButton={false}
          render={<span />}
          className="pointer-events-none absolute right-1 top-1/2 z-10 h-0 w-0 -translate-y-1/2"
        />
        {/* Visible ⋮ — desktop hover-reveal; hidden on touch (pointer-coarse),
            where the row's long-press opens the same menu as a bottom sheet. A
            plain button, not the trigger, so it can sit beside the anchor and
            open the controlled menu on click. */}
        <button
          type="button"
          data-sidebar="menu-action"
          aria-label={t("menu.options")}
          onClick={() => setMenuOpen(true)}
          className={`absolute right-1 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors before:absolute before:-inset-2.5 before:content-[''] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 pointer-coarse:hidden sm:opacity-0 sm:group-hover/menu-item:opacity-100 ${menuOpen ? "bg-sidebar-accent text-sidebar-accent-foreground opacity-100" : ""}`}
        >
          <MoreVertical className="size-4" />
        </button>
      </ActionMenu>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("menu.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("menu.deleteDescription", { title: chat.title || t("untitled") })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="destructive" onClick={deleteChat}>
              {tc("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("share.title")}</DialogTitle>
            <DialogDescription>{t("share.description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {([
              { value: "private", icon: Lock, label: t("share.private"), hint: t("share.privateHint") },
              { value: "link", icon: Globe, label: t("share.link"), hint: t("share.linkHint") },
              { value: "users", icon: Users, label: t("share.users"), hint: t("share.usersHint") },
            ] as const).map((opt) => {
              const Icon = opt.icon;
              const active = visibility === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={savingVisibility}
                  onClick={() => changeVisibility(opt.value)}
                  className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-60 ${
                    active ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
                  }`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                  </span>
                  {active && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>

          {visibility !== "private" && shareUrl && (
            <div className="flex items-center gap-2">
              <Input readOnly value={shareUrl} onFocus={(e) => e.target.select()} className="text-xs" />
              <Button type="button" variant="outline" size="icon" onClick={copyShareUrl} aria-label={t("share.copy")}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          )}

          {visibility !== "private" && (
            <DialogFooter>
              <Button variant="outline" onClick={() => changeVisibility("private")} disabled={savingVisibility}>
                {t("share.unpublish")}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
