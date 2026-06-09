"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Trash2, Plus, Pencil, Check, X, Loader2, Brain } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
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

import { MEMORY_TYPES, type MemoryType } from "@/lib/constants";

interface Memory {
  id: string;
  content: string;
  type: string;
  projectId: string | null;
  createdAt: string;
}

export default function MemoryPage() {
  const t = useTranslations("settings.memory");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editType, setEditType] = useState<MemoryType>("fact");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Form state
  const [newContent, setNewContent] = useState("");
  const [newType, setNewType] = useState<MemoryType>("fact");
  const [filterType, setFilterType] = useState<string>("all");

  const fetchMemories = useCallback(async () => {
    try {
      setError("");
      const url = filterType !== "all"
        ? `/api/memories?type=${filterType}`
        : "/api/memories";
      const res = await fetch(url);
      if (res.ok) setMemories(await res.json());
      else setError(t("loadError"));
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [filterType, t]);

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
        toast.success(t("added"));
      } else {
        toast.error(t("addFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
    if (res.ok) {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      setDeleteId(null);
      toast.success(t("deleted"));
    } else {
      toast.error(t("deleteFailed"));
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
      toast.success(t("updated"));
    } else {
      toast.error(t("updateFailed"));
    }
  };

  const grouped = {
    fact: memories.filter((m) => m.type === "fact"),
    preference: memories.filter((m) => m.type === "preference"),
    context: memories.filter((m) => m.type === "context"),
  };

  const typeLabel: Record<string, string> = {
    fact: t("types.fact"),
    preference: t("types.preference"),
    context: t("types.context"),
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>
      <Separator />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Filter + Add */}
      <div className="flex items-center gap-2">
        <Select value={filterType} onValueChange={(v) => setFilterType(v ?? "all")}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allTypes")}</SelectItem>
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
            {t("add")}
          </Button>
        )}
      </div>

      {/* Add form */}
      {showForm && (
        <div className="space-y-3 rounded-md border p-4">
          <div className="space-y-1.5">
            <label className="text-sm">{t("content")}</label>
            <Input
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder={t("contentPlaceholder")}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm">{t("type")}</label>
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
              {tc("save")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} disabled={saving}>
              {tc("cancel")}
            </Button>
          </div>
        </div>
      )}

      {/* Memory list */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && memories.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <Brain className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {t("empty")}
          </p>
        </div>
      )}

      {!loading && filterType !== "all" && memories.length > 0 && grouped[filterType as MemoryType]?.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {t("emptyFiltered", { type: (typeLabel[filterType as MemoryType] || filterType).toLowerCase() })}
        </p>
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
                        <Button variant="ghost" size="icon-xs" onClick={() => handleUpdate(m.id)} aria-label={tc("save")}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon-xs" onClick={cancelEdit} aria-label={tc("cancel")}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm">{m.content}</p>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">{typeLabel[m.type] || m.type}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(m.createdAt).toLocaleDateString(locale)}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => startEdit(m)}
                          aria-label={tc("edit")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteId(m.id)}
                          aria-label={tc("delete")}
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

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={() => deleteId && handleDelete(deleteId)}
        title={t("confirmDeleteTitle")}
        description={t("confirmDeleteDesc")}
      />
    </div>
  );
}
