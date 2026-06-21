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
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-1.5 py-0.5">
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
    </span>
  );
}

// Map a model's USD price (per 1M completion tokens) to a 0–4 tier. These
// thresholds are the one genuinely tunable bit of product judgement here —
// adjust the boundaries to taste; everything downstream just reads `tier`.
function priceTier(pricing: ModelInfo["pricing"]): number {
  const p = pricing?.completion ?? 0;
  if (p <= 0) return 0; // free / unknown
  if (p < 2) return 1;
  if (p < 8) return 2;
  if (p < 30) return 3;
  return 4;
}

/** Render a USD-per-1M-tokens figure compactly (e.g. "$0.50", "$15"). */
function formatPrice(v: number): string {
  if (v <= 0) return "$0";
  if (v < 1) return `$${v.toFixed(2)}`;
  return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)}`;
}

/** A compact "$ $ ·" cost meter — three slots, filled by tier, "+" for the top.
 *  The exact in/out prices live in the tooltip so the glance stays simple. */
function PriceMeter({ pricing }: { pricing: ModelInfo["pricing"] }) {
  const t = useTranslations("chat.model");
  const tier = priceTier(pricing);
  const filled = Math.min(tier, 3);
  const label =
    tier === 0 ? t("price.free") : `${"$".repeat(filled)}${tier >= 4 ? "+" : ""}`;
  const title =
    tier === 0
      ? t("price.free")
      : `${label} · ${t("price.io", {
          in: formatPrice(pricing?.prompt ?? 0),
          out: formatPrice(pricing?.completion ?? 0),
        })}`;
  return (
    <span
      className="inline-flex shrink-0 items-center font-medium tabular-nums leading-none"
      title={title}
      aria-label={title}
    >
      {[0, 1, 2].map((i) =>
        i < filled ? (
          <span key={i} className="text-emerald-500">$</span>
        ) : (
          <span key={i} className="text-muted-foreground/40">·</span>
        ),
      )}
      {tier >= 4 && <span className="text-emerald-500">+</span>}
    </span>
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

// The left rail's "Featured" tab — a synthetic group that gathers every
// starred model across providers, so the user's curated picks are one click
// away regardless of which company they came from.
const FEATURED_TAB = "__featured__";

interface GroupEntry {
  group: string;
  icon?: string | null;
  models: ModelInfo[];
}

/** Group a flat model list into provider sections, ordered by GROUP_PRIORITY
 *  then alphabetically, each sorted featured-first. Shared by the rail (built
 *  from all models) and the right pane (built from the filtered set). */
function buildGroups(list: ModelInfo[]): GroupEntry[] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of list) {
    const g = groupOf(m);
    const arr = map.get(g) ?? [];
    arr.push(m);
    map.set(g, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      const ai = GROUP_PRIORITY.indexOf(a);
      const bi = GROUP_PRIORITY.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(([group, models]) => ({ group, icon: models[0]?.icon, models }));
}

/** Vertical (desktop) / horizontal (mobile) strip of provider glyphs that
 *  drives which company's models the right pane shows. */
function ProviderRail({
  groups,
  hasFeatured,
  active,
  onSelect,
  orientation,
}: {
  groups: GroupEntry[];
  hasFeatured: boolean;
  active: string | null;
  onSelect: (tab: string) => void;
  orientation: "vertical" | "horizontal";
}) {
  const t = useTranslations("chat.model");
  const vertical = orientation === "vertical";
  const item = (key: string, title: string, glyph: React.ReactNode) => {
    const isActive = active === key;
    return (
      <button
        key={key}
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={isActive}
        onClick={() => onSelect(key)}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors ${
          isActive
            ? "bg-background text-foreground ring-1 ring-border shadow-sm"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        }`}
      >
        {glyph}
      </button>
    );
  };
  return (
    <div
      className={`flex shrink-0 gap-1 ${
        vertical
          ? "flex-col items-center overflow-y-auto overscroll-contain border-r p-2"
          : "flex-row items-center overflow-x-auto border-b p-2"
      }`}
    >
      {hasFeatured && (
        <>
          {item(FEATURED_TAB, t("featured"), <Star className="h-4 w-4" />)}
          <span className={vertical ? "my-1 h-px w-6 bg-border" : "mx-1 h-6 w-px bg-border"} />
        </>
      )}
      {groups.map((g) => item(g.group, g.group, <BrandIcon slug={g.icon} size={18} />))}
    </div>
  );
}

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
  orientation = "vertical",
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
  orientation?: "vertical" | "horizontal";
}) {
  const t = useTranslations("chat.model");
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  const searching = search.trim().length > 0;

  // Only tool-capable models are usable here, so they're the only ones listed.
  const models = useMemo(() => state.models.filter(hasTools), [state.models]);
  // Rail is built from the full set so it stays stable while searching/filtering.
  const railGroups = useMemo(() => buildGroups(models), [models]);
  const hasFeatured = useMemo(() => models.some((m) => m.featured), [models]);

  const filtered = useMemo(() => {
    if (!searching) return models;
    const q = search.trim().toLowerCase();
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        groupOf(m).toLowerCase().includes(q),
    );
  }, [models, search, searching]);

  // Which company's models fill the right pane. Until the user clicks the rail
  // (`tab` stays null), it falls back to the current model's provider — derived,
  // not stored, so it tracks the catalog loading without a state-syncing effect.
  const [tab, setTab] = useState<string | null>(null);
  const defaultTab = useMemo(() => {
    if (railGroups.length === 0) return null;
    const cur = models.find((m) => m.id === currentModelId);
    return cur ? groupOf(cur) : railGroups[0].group;
  }, [railGroups, models, currentModelId]);
  const activeTab = tab ?? defaultTab;

  // The right pane shows: search results (across all providers) when searching,
  // the featured set on the Featured tab, otherwise the active provider only.
  const sections = useMemo<GroupEntry[]>(() => {
    if (searching) return buildGroups(filtered);
    if (activeTab === FEATURED_TAB) return buildGroups(filtered.filter((m) => m.featured));
    return buildGroups(filtered.filter((m) => groupOf(m) === activeTab));
  }, [searching, filtered, activeTab]);

  // Multi-provider views need headers to tell companies apart; a single
  // provider's list doesn't (the rail already names it).
  const showHeaders = searching || activeTab === FEATURED_TAB;

  // Flatten the visible models for keyboard navigation + active-index math.
  const visible = useMemo(() => sections.flatMap((s) => s.models), [sections]);
  const indexMap = useMemo(() => new Map(visible.map((m, i) => [m.id, i])), [visible]);

  const pickTab = (next: string) => {
    onSearch("");
    onActiveIndex(0);
    setTab(next);
  };

  // When a single company fills the pane (no per-group sticky headers), name it
  // up top so the user always knows which provider they're looking at.
  const paneHeading = !showHeaders ? sections[0] : null;

  const right = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {paneHeading && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <BrandIcon slug={paneHeading.icon} size={15} />
          <span className="text-sm font-medium">{paneHeading.group}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">{paneHeading.models.length}</span>
        </div>
      )}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          value={search}
          onChange={(e) => { onSearch(e.target.value); onActiveIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); onActiveIndex(Math.min(activeIndex + 1, visible.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); onActiveIndex(Math.max(activeIndex - 1, 0)); }
            else if (e.key === "Enter" && visible[activeIndex]) { e.preventDefault(); onSelect(visible[activeIndex]); }
            else if (e.key === "Escape") { onClose(); }
          }}
          placeholder={t("search")}
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={visible.length ? optionId(activeIndex) : undefined}
          aria-label={t("search")}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {searching && <span className="text-[10px] text-muted-foreground tabular-nums">{visible.length}</span>}
      </div>

      <div ref={listRef} id={listboxId} role="listbox" aria-label={t("selectModel")} className="flex-1 overflow-y-auto overscroll-contain">
        {state.loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {!state.loading && visible.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {state.syncing ? (
              <span className="flex flex-col items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" />{t("syncing")}</span>
            ) : state.needsKey ? (
              <span className="flex flex-col items-center gap-1.5"><KeyRound className="h-4 w-4" />{t("needKey")}</span>
            ) : state.error ? (
              <span className="flex flex-col items-center gap-1.5 text-destructive"><AlertCircle className="h-4 w-4" />{state.error}</span>
            ) : searching ? (
              t("noneFound")
            ) : (
              t("noneAvailable")
            )}
          </div>
        )}

        {sections.map(({ group, icon, models: groupModels }) => (
          <div key={group}>
            {showHeaders && (
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 backdrop-blur-sm px-3 py-1.5 border-b border-border/50">
                <BrandIcon slug={icon} size={12} />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{group}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">{groupModels.length}</span>
              </div>
            )}

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
                  <PriceMeter pricing={model.pricing} />
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
        ))}
      </div>
    </div>
  );

  // No companies to choose between (loading, error, single provider) → skip the
  // rail entirely and let the list use the full width.
  const showRail = railGroups.length > 1 || hasFeatured;
  if (!showRail) return right;

  return (
    <div className={`flex min-h-0 flex-1 ${orientation === "vertical" ? "flex-row" : "flex-col"}`}>
      <ProviderRail
        groups={railGroups}
        hasFeatured={hasFeatured}
        active={searching ? null : activeTab}
        onSelect={pickTab}
        orientation={orientation}
      />
      {right}
    </div>
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

  const renderList = (orientation: "vertical" | "horizontal") => (
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
      orientation={orientation}
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
          {/* Until the catalog resolves the friendly name, show a skeleton rather
              than the raw model id — it would otherwise flash "glm-5.2" before
              snapping to "GLM 5.2". */}
          {state.loading && !currentModel ? (
            <span className="h-4 w-28 animate-pulse rounded-md bg-muted" />
          ) : (
            <span className="flex items-baseline gap-1.5 min-w-0">
              <span className="truncate max-w-52 font-medium text-foreground">{displayName || placeholderText}</span>
              {currentModel && currentModel.context > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums hidden md:inline" title={t("context")}>{formatContext(currentModel.context)}</span>
              )}
              {state.isShared && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground hidden sm:inline" title={t("sharedTooltip")}>{t("shared")}</span>
              )}
            </span>
          )}
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
          {state.loading && !currentModel ? (
            <span className="h-4 flex-1 animate-pulse rounded-md bg-muted" />
          ) : (
            <span className={`flex-1 truncate text-left ${displayName ? "" : "text-muted-foreground"}`}>
              {displayName || placeholderText}
            </span>
          )}
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
          className={`absolute top-full mt-1 z-50 flex h-96 overflow-hidden rounded-xl border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-150 max-w-[calc(100vw-1rem)] ${
            variant === "field" ? "left-0 w-[28rem] min-w-full" : "left-0 w-[28rem]"
          }`}
        >
          {renderList("vertical")}
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
          <div className="flex flex-1 flex-col min-h-0">{renderList("horizontal")}</div>
        </div>
      )}
    </div>
  );
}
