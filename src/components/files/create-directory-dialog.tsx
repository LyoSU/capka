"use client";

import { useState } from "react";
import { FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function CreateDirectoryDialog({
  currentPath,
  projectId,
  onCreated,
}: {
  currentPath: string;
  projectId?: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "mkdir",
          path: currentPath,
          name: name.trim(),
          projectId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create directory");
        return;
      }

      setName("");
      setOpen(false);
      onCreated();
    } catch {
      setError("Failed to create directory");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setName(""); setError(""); } }}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <FolderPlus className="h-3.5 w-3.5" data-icon="inline-start" />
            New folder
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Create a new folder in the current directory.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); handleCreate(); }}
          className="space-y-3"
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Folder name"
            autoFocus
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>

        <DialogFooter>
          <Button onClick={handleCreate} disabled={!name.trim() || loading} size="sm">
            {loading ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
