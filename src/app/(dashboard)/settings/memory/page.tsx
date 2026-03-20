"use client";

import { useEffect, useState, useCallback } from "react";
import { Trash2, Plus, Pencil, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

import { MEMORY_TYPES, type MemoryType } from "@/app/api/memories/route";

interface Memory {
  id: string;
  content: string;
  type: string;
  projectId: string | null;
  createdAt: string;
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editType, setEditType] = useState<MemoryType>("fact");

  // Form state
  const [newContent, setNewContent] = useState("");
  const [newType, setNewType] = useState<MemoryType>("fact");
  const [filterType, setFilterType] = useState<string>("all");

  const fetchMemories = useCallback(async () => {
    try {
      const url = filterType !== "all"
        ? `/api/memories?type=${filterType}`
        : "/api/memories";
      const res = await fetch(url);
      if (res.ok) setMemories(await res.json());
    } finally {
      setLoading(false);
    }
  }, [filterType]);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent, type: newType }),
      });
      if (res.ok) {
        const memory = await res.json();
        setMemories((prev) => [memory, ...prev]);
        setNewContent("");
        setNewType("fact");
        setShowForm(false);
        toast.success("Memory added");
      } else {
        toast.error("Failed to add memory");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
    if (res.ok) {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      toast.success("Memory deleted");
    } else {
      toast.error("Failed to delete memory");
    }
  };

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditContent(m.content);
    setEditType(m.type as MemoryType);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent("");
  };

  const handleUpdate = async (id: string) => {
    const res = await fetch(`/api/memories/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editContent, type: editType }),
    });
    if (res.ok) {
      const updated = await res.json();
      setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, ...updated } : m)));
      setEditingId(null);
      toast.success("Memory updated");
    } else {
      toast.error("Failed to update memory");
    }
  };

  const grouped = {
    fact: memories.filter((m) => m.type === "fact"),
    preference: memories.filter((m) => m.type === "preference"),
    context: memories.filter((m) => m.type === "context"),
  };

  const typeLabel: Record<string, string> = {
    fact: "Facts",
    preference: "Preferences",
    context: "Context",
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">Agent Memory</h2>
        <p className="text-sm text-muted-foreground">
          Things the AI remembers about you across conversations.
        </p>
      </div>
      <Separator />

      {/* Filter + Add */}
      <div className="flex items-center gap-2">
        <Select value={filterType} onValueChange={(v) => setFilterType(v ?? "all")}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {MEMORY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {typeLabel[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        {!showForm && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add memory
          </Button>
        )}
      </div>

      {/* Add form */}
      {showForm && (
        <div className="space-y-3 rounded-md border p-4">
          <div className="space-y-1.5">
            <label className="text-sm">Content</label>
            <Input
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="e.g. Prefers TypeScript over JavaScript"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm">Type</label>
            <Select value={newType} onValueChange={(v) => setNewType(v as MemoryType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {typeLabel[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Memory list */}
      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

      {!loading && memories.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No memories yet. The AI will learn about you as you chat, or you can add memories manually.
          </p>
        </div>
      )}

      {!loading &&
        (filterType === "all" ? MEMORY_TYPES : [filterType as MemoryType]).map((type) => {
          const items = grouped[type];
          if (!items || items.length === 0) return null;
          return (
            <div key={type} className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">{typeLabel[type]}</h3>
              {items.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start gap-2 rounded-md border p-3"
                >
                  {editingId === m.id ? (
                    <div className="flex flex-1 flex-col gap-2">
                      <Input
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleUpdate(m.id)}
                      />
                      <div className="flex items-center gap-2">
                        <Select value={editType} onValueChange={(v) => setEditType(v as MemoryType)}>
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MEMORY_TYPES.map((t) => (
                              <SelectItem key={t} value={t}>
                                {typeLabel[t]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button variant="ghost" size="icon-xs" onClick={() => handleUpdate(m.id)}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon-xs" onClick={cancelEdit}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm">{m.content}</p>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">{m.type}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(m.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => startEdit(m)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(m.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
    </div>
  );
}
