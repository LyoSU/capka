"use client";

import { useState, useEffect, useRef, useMemo, useCallback, type ComponentType } from "react";
import { Search, ChevronDown, X, Sparkles } from "lucide-react";
import OpenAI from "@lobehub/icons/es/OpenAI";
import Anthropic from "@lobehub/icons/es/Anthropic";
import Gemini from "@lobehub/icons/es/Gemini";
import Meta from "@lobehub/icons/es/Meta";
import Mistral from "@lobehub/icons/es/Mistral";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import XAI from "@lobehub/icons/es/XAI";
import Qwen from "@lobehub/icons/es/Qwen";
import Minimax from "@lobehub/icons/es/Minimax";
import XiaomiMiMo from "@lobehub/icons/es/XiaomiMiMo";
import Nvidia from "@lobehub/icons/es/Nvidia";
import type { ModelInfo } from "@/app/api/models/route";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const PROVIDER_META: Record<string, { label: string; icon: IconComponent }> = {
  openai: { label: "OpenAI", icon: OpenAI },
  anthropic: { label: "Anthropic", icon: Anthropic },
  google: { label: "Google", icon: Gemini },
  "meta-llama": { label: "Meta", icon: Meta },
  mistralai: { label: "Mistral", icon: Mistral },
  deepseek: { label: "DeepSeek", icon: DeepSeek },
  "x-ai": { label: "xAI", icon: XAI },
  qwen: { label: "Qwen", icon: Qwen },
  minimax: { label: "MiniMax", icon: Minimax },
  xiaomi: { label: "Xiaomi", icon: XiaomiMiMo },
  nvidia: { label: "NVIDIA", icon: Nvidia },
};

function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}k`;
  return String(ctx);
}

function formatPrice(price: number): string {
  if (price === 0) return "free";
  if (price < 0.01) return "<$0.01";
  if (price < 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(1)}`;
}

function getDisplayName(value: string): string {
  if (!value) return "select model";
  const parts = value.split(":");
  const modelPart = parts[parts.length - 1];
  return modelPart.includes("/") ? modelPart.split("/").pop()! : modelPart;
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
    return models.filter((m) => {
      const providerLabel = PROVIDER_META[m.provider]?.label || m.provider;
      return (
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        providerLabel.toLowerCase().includes(q)
      );
    });
  }, [models, search]);

  const indexMap = useMemo(() => new Map(filtered.map((m, i) => [m.id, i])), [filtered]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of filtered) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    const priority = ["openai", "anthropic", "google", "meta-llama", "mistralai", "deepseek", "x-ai", "qwen"];
    return [...map.entries()].sort(([a], [b]) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
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
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {filtered.length}
          </span>
        )}
      </div>

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain">
        {filtered.length === 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {search ? "No models found" : "No models available"}
          </div>
        )}

        {groups.map(([provider, providerModels]) => {
          const meta = PROVIDER_META[provider];
          const Icon = meta?.icon ?? Sparkles;

          return (
            <div key={provider}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 backdrop-blur-sm px-3 py-1.5 border-b border-border/50">
                <Icon size={12} />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {meta?.label ?? provider}
                </span>
                <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                  {providerModels.length}
                </span>
              </div>

              {providerModels.map((model) => {
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
                        <span className="truncate text-sm">{model.name}</span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-full bg-primary/10 text-primary px-1.5 py-0.5 text-[9px] font-medium">
                            active
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
                        {model.context > 0 && (
                          <span className="tabular-nums">{formatContext(model.context)} ctx</span>
                        )}
                        {model.pricing.prompt > 0 && (
                          <span className="tabular-nums">{formatPrice(model.pricing.prompt)}/M</span>
                        )}
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
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Detect mobile
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Fetch models on first open
  useEffect(() => {
    if (!open || models.length > 0) return;
    setLoading(true);
    fetch("/api/models")
      .then((r) => r.json())
      .then((data) => setModels(data.models ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, models.length]);

  // Close on outside click (desktop only)
  useEffect(() => {
    if (!open || isMobile) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, isMobile]);

  // Reset on open
  useEffect(() => {
    if (open) { setSearch(""); setActiveIndex(0); }
  }, [open]);

  // Lock body scroll on mobile
  useEffect(() => {
    if (open && isMobile) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [open, isMobile]);

  const select = useCallback(
    (model: ModelInfo) => {
      onChange(`openrouter:${model.id}`);
      setOpen(false);
    },
    [onChange],
  );

  // Scroll active into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const currentModelId = value.includes(":") ? value.split(":").slice(1).join(":") : value;
  const currentProvider = currentModelId.includes("/") ? currentModelId.split("/")[0] : "";
  const CurrentProviderIcon = PROVIDER_META[currentProvider]?.icon;

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {CurrentProviderIcon && <CurrentProviderIcon size={14} />}
        <span className="truncate max-w-40">{getDisplayName(value)}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 opacity-50 transition-transform ${open ? "rotate-180" : ""}`} />
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
