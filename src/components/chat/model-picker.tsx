"use client";

import { useState, useEffect, useRef, useMemo, useCallback, useId, createElement } from "react";
import { useTranslations } from "next-intl";
import { Search, ChevronDown, X, Eye, Brain, Star, Loader2, KeyRound, AlertCircle } from "lucide-react";
import { iconForSlug } from "./provider-icons";
import { parseModelId, displayModelName, PROVIDER_META, type ProviderName } from "@/lib/providers/registry";
import type { ModelInfo } from "@/app/api/models/route";

/** Brand glyph — resolves a slug to a stable icon component (dynamic select). */
function BrandIcon({ slug, size, className }: { slug?: string | null; size?: number; className?: string }) {
  return createElement(iconForSlug(slug), { size, className });
}

// Companies shown first — the rest follow alphabetically. Keeps the common
// choices on top without hiding the long tail.
const GROUP_PRIORITY = ["Anthropic", "OpenAI", "Google", "Meta", "Mistral", "DeepSeek", "xAI", "Qwen"];

function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`;
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}K`;
  return String(ctx);
}

function groupOf(m: ModelInfo): string {
  return m.group || (m.provider ? m.provider : "Other");
}

/** A model is usable on this agentic platform only if it can call tools. */
function hasTools(m: ModelInfo): boolean {
  return !!m.capabilities?.tools;
}

/** Drop the "Provider:" prefix the catalog bakes into display names — the brand
 *  icon and the group header already convey the provider, so "Google: Gemini …"
 *  next to a Google icon under a Google header reads as a stutter. */
function stripGroup(name: string, group?: string | null): string {
  if (group && name.toLowerCase().startsWith(`${group.toLowerCase()}:`)) {
    return name.slice(group.length + 1).trim();
  }
  return name;
}

function Caps({ caps }: { caps: ModelInfo["capabilities"] }) {
  const t = useTranslations("chat.model");
  if (!caps || (!caps.vision && !caps.reasoning)) return null;
  // Tool-calling is now a hard filter (every listed model has it), so its icon
  // would just be noise. Only the capabilities that actually vary are shown,
  // with plain-language meaning on hover and for screen readers.
  return (
    <>
      {caps.vision && (
        <span title={t("caps.vision")} className="inline-flex">
          <Eye className="h-3.5 w-3.5" aria-label={t("caps.vision")} />
        </span>
      )}
      {caps.reasoning && (
        <span title={t("caps.reasoning")} className="inline-flex">
          <Brain className="h-3.5 w-3.5" aria-label={t("caps.reasoning")} />
        </span>
      )}
    </>
  );
}

// ── Data ─────────────────────────────────────────────────────────────────

type Source =
  | { mode: "active" }
  | { mode: "config"; configId: string }
  | { mode: "credentials"; provider: ProviderName; apiKey?: string; baseUrl?: string };

interface ModelsState {
  models: ModelInfo[];
  loading: boolean;
  error: string | null;
  isShared: boolean;
  needsKey: boolean;
  // The backend is still building the catalog (first-run OpenRouter sync). The
  // empty list is temporary, not a failure — surface it honestly so the user
  // waits instead of assuming their key is wrong.
  syncing: boolean;
}

// Cache last successful results per source so re-mounting the picker (every
// navigation between chats) shows models instantly and revalidates quietly,
// instead of flashing a spinner and re-probing the provider each time.
const CLIENT_MODELS_TTL_MS = 5 * 60_000;
const clientModelsCache = new Map<string, { at: number; models: ModelInfo[]; isShared: boolean }>();

function useModels(source: Source, fallbackValue: string, loadErrorMsg: string): ModelsState {
  const [state, setState] = useState<ModelsState>({
    models: [],
    loading: true,
    error: null,
    isShared: false,
    needsKey: false,
    syncing: false,
  });

  // Stable key so the effect only re-runs when the real inputs change.
  const key =
    source.mode === "credentials"
      ? `cred:${source.provider}:${source.apiKey ?? ""}:${source.baseUrl ?? ""}`
      : source.mode === "config"
        ? `cfg:${source.configId}`
        : "active";

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Credentials mode for a key-requiring provider with no key yet: don't
    // call the API — just prompt for the key.
    if (source.mode === "credentials" && PROVIDER_META[source.provider]?.requiresKey && !source.apiKey) {
      setState({ models: [], loading: false, error: null, isShared: false, needsKey: true, syncing: false });
      return;
    }

    const cached = clientModelsCache.get(key);
    if (cached && Date.now() - cached.at < CLIENT_MODELS_TTL_MS) {
      // Serve from cache immediately; the fetch below revalidates in the
      // background without flipping back to a loading state.
      setState({ models: cached.models, loading: false, error: null, isShared: cached.isShared, needsKey: false, syncing: false });
    } else {
      setState((s) => ({ ...s, loading: true, error: null, needsKey: false, syncing: false }));
    }

    const load = async () => {
      try {
        let res: Response;
        if (source.mode === "credentials") {
          res = await fetch("/api/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: source.provider, apiKey: source.apiKey, baseUrl: source.baseUrl }),
          });
        } else if (source.mode === "config") {
          res = await fetch(`/api/models?configId=${encodeURIComponent(source.configId)}`);
        } else {
          res = await fetch("/api/models");
        }
        const data = res.ok ? await res.json() : { models: [] };
        if (cancelled) return;
        if (res.ok && Array.isArray(data.models) && data.models.length > 0) {
          clientModelsCache.set(key, { at: Date.now(), models: data.models, isShared: !!data.isShared });
        }
        setState({
          models: data.models ?? [],
          loading: false,
          error: data.error ?? null,
          isShared: !!data.isShared,
          needsKey: false,
          syncing: !!data.syncing,
        });
        // First-run: catalog still syncing — keep polling until it fills in.
        if (data.syncing) retry = setTimeout(load, 4000);
      } catch {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            // tool-capable so the picker's hasTools filter keeps it — the user
            // must still see (and keep) their current model when a load fails.
            models: s.models.length ? s.models : [{ id: fallbackValue, name: displayModelName(fallbackValue), provider: "", context: 0, pricing: { prompt: 0, completion: 0 }, capabilities: { vision: false, tools: true, reasoning: false } }],
            loading: false,
            error: loadErrorMsg,
            syncing: false,
          }));
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the inputs; fallbackValue is only a last-resort label
  }, [key]);

  return state;
}

// ── List ─────────────────────────────────────────────────────────────────

function ModelList({
  state,
  search,
  onSearch,
  onSelect,
  currentModelId,
  activeIndex,
  onActiveIndex,
  listRef,
  onClose,
}: {
  state: ModelsState;
  search: string;
  onSearch: (s: string) => void;
  onSelect: (m: ModelInfo) => void;
  currentModelId: string;
  activeIndex: number;
  onActiveIndex: (i: number) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const t = useTranslations("chat.model");
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  // Only tool-capable models are usable here, so they're the only ones listed.
  const models = useMemo(() => state.models.filter(hasTools), [state.models]);
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
          placeholder={t("search")}
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={filtered.length ? optionId(activeIndex) : undefined}
          aria-label={t("search")}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {search && <span className="text-[10px] text-muted-foreground tabular-nums">{filtered.length}</span>}
      </div>

      <div ref={listRef} id={listboxId} role="listbox" aria-label={t("selectModel")} className="flex-1 overflow-y-auto overscroll-contain">
        {state.loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {!state.loading && filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {state.syncing ? (
              <span className="flex flex-col items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" />{t("syncing")}</span>
            ) : state.needsKey ? (
              <span className="flex flex-col items-center gap-1.5"><KeyRound className="h-4 w-4" />{t("needKey")}</span>
            ) : state.error ? (
              <span className="flex flex-col items-center gap-1.5 text-destructive"><AlertCircle className="h-4 w-4" />{state.error}</span>
            ) : search ? (
              t("noneFound")
            ) : (
              t("noneAvailable")
            )}
          </div>
        )}

        {groups.map(([group, groupModels]) => {
          return (
            <div key={group}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 backdrop-blur-sm px-3 py-1.5 border-b border-border/50">
                <BrandIcon slug={groupModels[0]?.icon} size={12} />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{group}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">{groupModels.length}</span>
              </div>

              {groupModels.map((model) => {
                const globalIdx = indexMap.get(model.id) ?? -1;
                const isActive = globalIdx === activeIndex;
                const isCurrent = model.id === currentModelId;
                return (
                  <button
                    key={model.id}
                    id={optionId(globalIdx)}
                    role="option"
                    aria-selected={isActive}
                    data-index={globalIdx}
                    onClick={() => onSelect(model)}
                    onMouseEnter={() => onActiveIndex(globalIdx)}
                    className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors active:bg-accent ${isActive ? "bg-accent" : ""} ${isCurrent ? "bg-accent/50" : ""}`}
                  >
                    {model.featured && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                    <span className="min-w-0 flex-1 truncate text-sm">{stripGroup(model.name, group)}</span>
                    {isCurrent && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">{t("active")}</span>
                    )}
                    <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                      {model.context > 0 && (
                        <span className="tabular-nums" title={t("context")}>{formatContext(model.context)}</span>
                      )}
                      <Caps caps={model.capabilities} />
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Picker ───────────────────────────────────────────────────────────────

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  /** "pill" — the slim chat trigger; "field" — a form input. Default "field". */
  variant?: "pill" | "field";
  /** Configure mode: list models for these unsaved credentials. */
  provider?: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  /** List models for a specific saved provider config (editing its default). */
  configId?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function ModelPicker({
  value,
  onChange,
  variant = "field",
  provider,
  apiKey,
  baseUrl,
  configId,
  placeholder,
  disabled,
}: ModelPickerProps) {
  const t = useTranslations("chat.model");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const source: Source = provider
    ? { mode: "credentials", provider, apiKey, baseUrl }
    : configId
      ? { mode: "config", configId }
      : { mode: "active" };

  const state = useModels(source, value, t("loadError"));

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (!open || isMobile) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, isMobile]);

  useEffect(() => {
    if (open && isMobile) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [open, isMobile]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const toggleOpen = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      if (!prev) { setSearch(""); setActiveIndex(0); }
      return !prev;
    });
  }, [disabled]);

  const select = useCallback(
    (model: ModelInfo) => {
      onChange(model.id);
      setOpen(false);
    },
    [onChange],
  );

  const currentModelId = parseModelId(value).modelId;
  const currentModel = state.models.find((m) => m.id === currentModelId);
  const groupLabel = currentModel ? groupOf(currentModel) : null;
  const displayName = stripGroup(currentModel?.name || (value ? displayModelName(value) : ""), groupLabel);
  const placeholderText = placeholder ?? t("placeholder");

  const list = (
    <ModelList
      state={state}
      search={search}
      onSearch={setSearch}
      onSelect={select}
      currentModelId={currentModelId}
      activeIndex={activeIndex}
      onActiveIndex={setActiveIndex}
      listRef={listRef}
      onClose={close}
    />
  );

  return (
    <div ref={containerRef} className="relative">
      {variant === "pill" ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex h-9 items-center gap-2.5 px-3 text-sm hover:text-foreground transition-colors"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted shrink-0">
            <BrandIcon slug={currentModel?.icon} size={14} />
          </span>
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="truncate max-w-52 font-medium text-foreground">{displayName || placeholderText}</span>
            {currentModel && currentModel.context > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums hidden md:inline" title={t("context")}>{formatContext(currentModel.context)}</span>
            )}
            {state.isShared && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground hidden sm:inline" title={t("sharedTooltip")}>{t("shared")}</span>
            )}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-40 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex h-9 w-full items-center gap-2 rounded-md border bg-transparent px-3 text-sm transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <BrandIcon slug={currentModel?.icon} size={15} className="shrink-0 text-muted-foreground" />
          <span className={`flex-1 truncate text-left ${displayName ? "" : "text-muted-foreground"}`}>
            {displayName || placeholderText}
          </span>
          {state.loading || state.syncing ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/50" />
          ) : (
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-40 transition-transform ${open ? "rotate-180" : ""}`} />
          )}
        </button>
      )}

      {open && !isMobile && (
        <div
          onKeyDown={(e) => { if (e.key === "Escape") close(); }}
          className={`absolute top-full mt-1 z-50 flex max-h-96 flex-col overflow-hidden rounded-xl border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-150 ${
            variant === "field" ? "inset-x-0 w-full" : "left-0 w-80"
          }`}
        >
          {list}
        </div>
      )}

      {open && isMobile && (
        <div
          onKeyDown={(e) => { if (e.key === "Escape") close(); }}
          className="fixed inset-0 z-50 flex flex-col bg-background"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-medium">{t("selectModel")}</span>
            <button onClick={close} aria-label={t("close")} className="rounded-md p-1 hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-1 flex-col min-h-0">{list}</div>
        </div>
      )}
    </div>
  );
}
