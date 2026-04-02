"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Pin,
  PinOff,
  Archive,
  Pencil,
  Trash2,
  Download,
  MoreHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

type ChatItem = {
  id: string;
  title: string | null;
  pinned: boolean | null;
  archived: boolean | null;
};

export function ChatContextMenu({
  chat,
  onUpdate,
  children,
}: {
  chat: ChatItem;
  onUpdate: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  async function patchChat(data: Record<string, unknown>) {
    await fetch(`/api/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    onUpdate();
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
        className="flex-1 px-1"
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === "Escape") setRenaming(false);
          }}
          className="h-6 text-sm px-1.5"
          autoFocus
        />
      </form>
    );
  }

  return (
    <>
      <div className="group/chat flex items-center w-full">
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="ml-auto sm:opacity-0 sm:group-hover/chat:opacity-100 shrink-0 rounded p-0.5 hover:bg-accent focus-visible:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" sideOffset={8}>
            <DropdownMenuItem onClick={startRename}>
              <Pencil className="h-4 w-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => patchChat({ pinned: !chat.pinned })}
            >
              {chat.pinned ? (
                <>
                  <PinOff className="h-4 w-4" />
                  Unpin
                </>
              ) : (
                <>
                  <Pin className="h-4 w-4" />
                  Pin
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => patchChat({ archived: !chat.archived })}
            >
              <Archive className="h-4 w-4" />
              {chat.archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                window.open(`/api/chats/${chat.id}/export?format=markdown`, "_blank");
              }}
            >
              <Download className="h-4 w-4" />
              Export
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat</DialogTitle>
            <DialogDescription>
              This will permanently delete &ldquo;{chat.title || "New Chat"}&rdquo; and all its messages.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteChat}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
