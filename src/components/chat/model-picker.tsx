"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

type Model = { id: string; name: string; provider: string; context: number };

/**
 * Lightweight model picker for settings / onboarding.
 * Fetches from /api/models and shows a searchable list.
 */
export function ModelPicker({
  value,
  onChange,
  placeholder = "Search models...",
}: {
  value: string;
  onChange: (modelId: string) => void;
  placeholder?: string;
}) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/models")
      .then((r) => r.ok ? r.json() : { models: [] })
      .then((d) => setModels(d.models ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search) return models.slice(0, 50);
    const q = search.toLowerCase();
    return models.filter((m) =>
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [models, search]);

  const selectedName = models.find((m) => m.id === value)?.name
    || (value ? value.split("/").pop() : "");

  return (
    <div className="relative">
      <Input
        value={open ? search : selectedName || value}
        onChange={(e) => { setSearch(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="h-9 text-sm pr-8"
      />
      {loading ? (
        <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Search className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground/50" />
      )}

      {open && !loading && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border bg-popover shadow-lg">
          {filtered.length === 0 && (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {search ? "No models found" : "No models available"}
            </div>
          )}
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${m.id === value ? "bg-accent/50" : ""}`}
              onClick={() => {
                onChange(m.id);
                setSearch("");
                setOpen(false);
              }}
            >
              <span className="truncate">{m.name}</span>
              <span className="ml-2 shrink-0 text-[11px] text-muted-foreground/50">{m.provider}</span>
            </button>
          ))}
          {search && (
            <button
              type="button"
              className="flex w-full items-center px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent border-t"
              onClick={() => { onChange(search); setSearch(""); setOpen(false); }}
            >
              Use custom: <span className="ml-1 font-mono">{search}</span>
            </button>
          )}
        </div>
      )}

      {/* Close on click outside */}
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
    </div>
  );
}
