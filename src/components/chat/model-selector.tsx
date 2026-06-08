"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Search, ChevronDown, X, Eye, Wrench, Brain, Star } from "lucide-react";
import { iconForSlug } from "./provider-icons";
import type { ModelInfo } from "@/app/api/models/route";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

// Companies shown first — the rest follow alphabetically. Keeps the common
// choices on top without hiding the long tail.
const GROUP_PRIORITY = ["Anthropic", "OpenAI", "Google", "Meta", "Mistral", "DeepSeek", "xAI", "Qwen"];

function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}k`;
  return String(ctx);
}

function formatPrice(p: number): string {
  return `$${p < 1 ? p.toFixed(2) : p.toFixed(1)}/M`;
}

function getDisplayName(value: string): string {
  if (!value) return "select model";
  const parts = value.split(":");
  const modelPart = parts[parts.length - 1];
  return modelPart.includes("/") ? modelPart.split("/").pop()! : modelPart;
}

function groupOf(m: ModelInfo): string {
  return m.group || (m.provider ? m.provider : "Other");
}

function Caps({ caps }: { caps: ModelInfo["capabilities"] }) {
  if (!caps) return null;
  return (
    <span className="flex items-center gap-1 text-muted-foreground/40">
      {caps.vision && <Eye className="h-3 w-3" aria-label="vision" />}
      {caps.tools && <Wrench className="h-3 w-3" aria-label="tools" />}
      {caps.reasoning && <Brain className="h-3 w-3" aria-label="reasoning" />}
    </span>
  );
}

function ModelList({
  models,
  search,
  onSearch,
  onSelect,
  currentModelId,
  activeIndex,
  onActiveIndex,
  listRef,
  onClose,
}: {
  models: ModelInfo[];
  search: string;
  onSearch: (s: string) => void;
  onSelect: (m: ModelInfo) => void;
  currentModelId: string;
  activeIndex: number;
  onActiveIndex: (i: number) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const filtered = useMemo(() => {
    if (!search) return models;
    const q = search.toLowerCase();
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        groupOf(m).toLowerCase().includes(q),
    );
  }, [models, search]);

  const indexMap = useMemo(() => new Map(filtered.map((m, i) => [m.id, i])), [filtered]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of filtered) {
      const g = groupOf(m);
      const list = map.get(g) ?? [];
      list.push(m);
      map.set(g, list);
    }
    // Featured models first within each group, then by name.
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
    }
    return [...map.entries()].sort(([a], [b]) => {
      const ai = GROUP_PRIORITY.indexOf(a);
      const bi = GROUP_PRIORITY.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <>
      {/* Search */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          value={search}
          onChange={(e) => { onSearch(e.target.value); onActiveIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); onActiveIndex(Math.min(activeIndex + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); onActiveIndex(Math.max(activeIndex - 1, 0)); }
            else if (e.key === "Enter" && filtered[activeIndex]) { e.preventDefault(); onSelect(filtered[activeIndex]); }
            else if (e.key === "Escape") { onClose(); }
          }}
          placeholder="Search models..."
          autoFocus
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
        {search && (
          <span className="text-[10px] text-muted-foreground tabular-nums">{filtered.length}</span>
        )}
      </div>

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain">
        {filtered.length === 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {search ? "No models found" : "No models available"}
          </div>
        )}

        {groups.map(([group, groupModels]) => {
          const Icon = iconForSlug(groupModels[0]?.icon);
          return (
            <div key={group}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 backdrop-blur-sm px-3 py-1.5 border-b border-border/50">
                <Icon size={12} />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{group}</span>
                <span className="text-[10px] text-muted-foreground/50 tabular-nums">{groupModels.length}</span>
              </div>

              {groupModels.map((model) => {
                const globalIdx = indexMap.get(model.id) ?? -1;
                const isActive = globalIdx === activeIndex;
                const isCurrent = model.id === currentModelId;

                return (
                  <button
                    key={model.id}
                    data-index={globalIdx}
                    onClick={() => onSelect(model)}
                    onMouseEnter={() => onActiveIndex(globalIdx)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors active:bg-accent ${
                      isActive ? "bg-accent" : ""
                    } ${isCurrent ? "bg-accent/50" : ""}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {model.featured && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                        <span className="truncate text-sm">{model.name}</span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-full bg-primary/10 text-primary px-1.5 py-0.5 text-[9px] font-medium">active</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground/60">
                        {model.context > 0 && <span className="tabular-nums">{formatContext(model.context)} ctx</span>}
                        {model.pricing.prompt > 0 && <span className="tabular-nums">{formatPrice(model.pricing.prompt)} in</span>}
                        <Caps caps={model.capabilities} />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Manual input */}
      <div className="border-t px-3 py-2">
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && search.trim()) {
              onSelect({ id: search, name: search, provider: "", context: 0, pricing: { prompt: 0, completion: 0 } });
            }
          }}
          placeholder="Or type model ID and press Enter"
          className="w-full bg-transparent text-[11px] text-muted-foreground outline-none placeholder:text-muted-foreground/40"
        />
      </div>
    </>
  );
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [configProvider, setConfigProvider] = useState("");
  const [isShared, setIsShared] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/models")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load models");
        return r.json();
      })
      .then((data) => { setModels(data.models ?? []); if (data.provider) setConfigProvider(data.provider); if (data.isShared) setIsShared(true); })
      .catch(() => setModels([{ id: value, name: value.split(":").pop() || value, provider: "", context: 0, pricing: { prompt: 0, completion: 0 } }]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount, value only used as fallback
  }, []);

  useEffect(() => {
    if (!open || isMobile) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, isMobile]);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      if (!prev) { setSearch(""); setActiveIndex(0); }
      return !prev;
    });
  }, []);

  useEffect(() => {
    if (open && isMobile) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [open, isMobile]);

  const select = useCallback(
    (model: ModelInfo) => {
      onChange(configProvider ? `${configProvider}:${model.id}` : model.id);
      setOpen(false);
    },
    [onChange, configProvider],
  );

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const currentModelId = value.includes(":") ? value.split(":").slice(1).join(":") : value;
  const currentModel = models.find((m) => m.id === currentModelId);
  const PillIcon = iconForSlug(currentModel?.icon);
  const groupLabel = currentModel ? groupOf(currentModel) : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={toggleOpen}
        className="flex h-9 items-center gap-2.5 px-3 text-sm hover:text-foreground transition-colors"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted shrink-0">
          <PillIcon size={14} />
        </span>
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="truncate max-w-52 font-medium text-foreground">{currentModel?.name || getDisplayName(value)}</span>
          {groupLabel && (
            <span className="text-xs text-muted-foreground/50 hidden sm:inline">{groupLabel}</span>
          )}
          {currentModel && currentModel.context > 0 && (
            <span className="text-xs text-muted-foreground/35 tabular-nums hidden md:inline">{formatContext(currentModel.context)} ctx</span>
          )}
          {isShared && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground hidden sm:inline" title="Using admin&apos;s shared provider config">shared</span>
          )}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-40 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && !isMobile && (
        <div className="absolute left-0 top-full mt-1 z-50 flex w-80 max-h-96 flex-col overflow-hidden rounded-xl border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-150">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
            </div>
          ) : (
            <ModelList
              models={models}
              search={search}
              onSearch={setSearch}
              onSelect={select}
              currentModelId={currentModelId}
              activeIndex={activeIndex}
              onActiveIndex={setActiveIndex}
              listRef={listRef}
              onClose={() => setOpen(false)}
            />
          )}
        </div>
      )}

      {/* Mobile: fullscreen sheet */}
      {open && isMobile && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-medium">Select model</span>
            <button onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
            </div>
          ) : (
            <div className="flex flex-1 flex-col min-h-0">
              <ModelList
                models={models}
                search={search}
                onSearch={setSearch}
                onSelect={select}
                currentModelId={currentModelId}
                activeIndex={activeIndex}
                onActiveIndex={setActiveIndex}
                listRef={listRef}
                onClose={() => setOpen(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
