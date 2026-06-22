"use client";

import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useId, createElement } from "react";
import { createPortal } from "react-dom";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
import { useTranslations } from "next-intl";
import { Search, ChevronDown, X, Eye, Brain, Star, Loader2, KeyRound, AlertCircle, FileText, AudioLines, Video } from "lucide-react";
import { iconForSlug } from "./provider-icons";
import { parseModelId, displayModelName, encodeModelRef, PROVIDER_META, type ProviderName } from "@/lib/providers/registry";
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

/** Stable, collision-proof identity for a row: the same model id can arrive
 *  from two enabled configs, so we key (and select) by the config-scoped ref.
 *  Untagged models (single-credential modes, legacy) fall back to the bare id. */
function refOf(m: ModelInfo): string {
  return m.configId ? encodeModelRef(m.configId, m.id) : m.id;
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
  const input = caps?.input ?? [];
  const hasPdf = input.includes("pdf");
  const hasAudio = input.includes("audio");
  const hasVideo = input.includes("video");
  if (!caps || (!caps.vision && !caps.reasoning && !hasPdf && !hasAudio && !hasVideo)) return null;
  // Tool-calling is now a hard filter (every listed model has it), so its icon
  // would just be noise. Only the capabilities that actually vary are shown,
  // with plain-language meaning on hover and for screen readers. Native input
  // modalities (PDF/audio/video) let the user see what they can attach; image
  // is already conveyed by the vision badge.
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-1.5 py-0.5">
      {caps.vision && (
        <span title={t("caps.vision")} className="inline-flex">
          <Eye className="h-3.5 w-3.5" aria-label={t("caps.vision")} />
        </span>
      )}
      {hasPdf && (
        <span title={t("caps.pdf")} className="inline-flex">
          <FileText className="h-3.5 w-3.5" aria-label={t("caps.pdf")} />
        </span>
      )}
      {hasAudio && (
        <span title={t("caps.audio")} className="inline-flex">
          <AudioLines className="h-3.5 w-3.5" aria-label={t("caps.audio")} />
        </span>
      )}
      {hasVideo && (
        <span title={t("caps.video")} className="inline-flex">
          <Video className="h-3.5 w-3.5" aria-label={t("caps.video")} />
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
/** An explicit free tier — the OpenRouter ":free" variant. A zero `priceTier`
 *  alone is ambiguous (it also means "price unknown"), so we badge "Free" only
 *  for this unmistakable signal and leave the neutral dots for the rest. */
function isFreeModel(m: ModelInfo): boolean {
  return /:free$/i.test(m.id);
}

function PriceMeter({ model }: { model: ModelInfo }) {
  const t = useTranslations("chat.model");
  const pricing = model.pricing;
  const tier = priceTier(pricing);
  const filled = Math.min(tier, 3);

  // A genuinely free model deserves a glanceable badge, not three muted dots
  // that read as "cheapest/unknown". Render the word, tinted like the meter.
  if (isFreeModel(model)) {
    return (
      <span
        className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase leading-none tracking-wide text-emerald-600 dark:text-emerald-400"
        title={t("price.free")}
        aria-label={t("price.free")}
      >
        {t("price.free")}
      </span>
    );
  }

  const label = `${"$".repeat(filled)}${tier >= 4 ? "+" : ""}`;
  const title = `${label} · ${t("price.io", {
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
  /** Stable identity used for the active-tab match. */
  key: string;
  /** Display label (header + rail). */
  group: string;
  icon?: string | null;
  models: ModelInfo[];
}

const sortFeaturedFirst = (a: ModelInfo, b: ModelInfo) =>
  Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name);

/** Group a flat model list by brand (company), ordered by GROUP_PRIORITY then
 *  alphabetically, each sorted featured-first. Used for the single-connection
 *  rail and for the brand sub-headers inside a connection's pane. */
function buildGroups(list: ModelInfo[]): GroupEntry[] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of list) {
    const g = groupOf(m);
    const arr = map.get(g) ?? [];
    arr.push(m);
    map.set(g, arr);
  }
  for (const arr of map.values()) arr.sort(sortFeaturedFirst);
  return [...map.entries()]
    .sort(([a], [b]) => {
      const ai = GROUP_PRIORITY.indexOf(a);
      const bi = GROUP_PRIORITY.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(([group, models]) => ({ key: group, group, icon: models[0]?.icon, models }));
}

/** Group by owning connection (provider config), preserving the order configs
 *  first appear — the enabled order from the server. Each tab keeps the
 *  connection's label + provider glyph; this is the top level whenever two or
 *  more configs are aggregated, so identical models land under distinct tabs. */
function buildConnectionGroups(list: ModelInfo[]): GroupEntry[] {
  const order: string[] = [];
  const map = new Map<string, ModelInfo[]>();
  for (const m of list) {
    const key = m.configId ?? "";
    if (!map.has(key)) { map.set(key, []); order.push(key); }
    map.get(key)!.push(m);
  }
  for (const arr of map.values()) arr.sort(sortFeaturedFirst);
  return order.map((key) => {
    const models = map.get(key)!;
    return { key, group: models[0]?.configLabel ?? key, icon: models[0]?.configIcon ?? null, models };
  });
}

/** The left (desktop) / top (mobile) tab strip that drives the right pane.
 *  `labeled` mode names each tab — used when tabs are connections, since two
 *  configs of the same provider share a glyph and need their label to differ;
 *  otherwise it's a compact glyph-only strip of brands. */
function ProviderRail({
  groups,
  hasFeatured,
  active,
  onSelect,
  orientation,
  labeled,
}: {
  groups: GroupEntry[];
  hasFeatured: boolean;
  active: string | null;
  onSelect: (tab: string) => void;
  orientation: "vertical" | "horizontal";
  labeled: boolean;
}) {
  const t = useTranslations("chat.model");
  const vertical = orientation === "vertical";

  const item = (key: string, title: string, glyph: React.ReactNode) => {
    const isActive = active === key;
    const activeCls = isActive
      ? "bg-background text-foreground ring-1 ring-border shadow-sm"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground";
    if (labeled) {
      return (
        <button
          key={key}
          type="button"
          title={title}
          aria-label={title}
          aria-pressed={isActive}
          onClick={() => onSelect(key)}
          className={`flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-left text-xs font-medium transition-colors ${activeCls} ${
            vertical ? "w-full" : ""
          }`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">{glyph}</span>
          <span className="truncate">{title}</span>
        </button>
      );
    }
    return (
      <button
        key={key}
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={isActive}
        onClick={() => onSelect(key)}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors ${activeCls}`}
      >
        {glyph}
      </button>
    );
  };

  return (
    <div
      className={`flex shrink-0 gap-1 ${
        vertical
          ? `flex-col overflow-y-auto overscroll-contain border-r p-2 ${labeled ? "w-40 items-stretch" : "items-center"}`
          : "flex-row items-center overflow-x-auto border-b p-2"
      }`}
    >
      {hasFeatured && (
        <>
          {item(FEATURED_TAB, t("featured"), <Star className="h-4 w-4" />)}
          <span className={vertical ? (labeled ? "my-1 h-px w-full bg-border" : "my-1 h-px w-6 bg-border") : "mx-1 h-6 w-px bg-border"} />
        </>
      )}
      {groups.map((g) => item(g.key, g.group, <BrandIcon slug={g.icon} size={18} />))}
    </div>
  );
}

function ModelList({
  state,
  search,
  onSearch,
  onSelect,
  currentRef,
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
  currentRef: string;
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

  // Two axes when more than one connection is enabled: a connection strip on
  // top, the classic brand rail on the left (scoped to the active connection).
  // One connection (or untagged models) → no top strip, just the brand rail —
  // identical to before. Decided from the data, no mode flag to keep in sync.
  const byConnection = useMemo(
    () => new Set(models.map((m) => m.configId).filter(Boolean)).size >= 2,
    [models],
  );

  // Top strip = connections; selecting one scopes the brand rail + pane below.
  const connTabs = useMemo(() => (byConnection ? buildConnectionGroups(models) : []), [models, byConnection]);
  const [connTab, setConnTab] = useState<string | null>(null);
  const defaultConn = useMemo(() => {
    if (!byConnection) return null;
    const cur = models.find((m) => refOf(m) === currentRef);
    return cur?.configId ?? connTabs[0]?.key ?? null;
  }, [byConnection, models, currentRef, connTabs]);
  const activeConn = connTab ?? defaultConn;

  // Models feeding the brand rail + pane: the active connection's, or all when a
  // single connection (or untagged) makes the top strip unnecessary.
  const scoped = useMemo(
    () => (byConnection && activeConn ? models.filter((m) => m.configId === activeConn) : models),
    [models, byConnection, activeConn],
  );

  // Left rail = brands of the scoped set. Built from the full scoped set so it
  // stays stable while searching/filtering.
  const brandGroups = useMemo(() => buildGroups(scoped), [scoped]);
  const hasFeatured = useMemo(() => scoped.some((m) => m.featured), [scoped]);

  // Search is global — across every connection — so a model is findable no
  // matter which tab is open.
  const searchResults = useMemo(() => {
    if (!searching) return [];
    const q = search.trim().toLowerCase();
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        groupOf(m).toLowerCase().includes(q) ||
        (m.configLabel ?? "").toLowerCase().includes(q),
    );
  }, [models, search, searching]);

  // Which brand fills the pane. Until the user clicks the rail it falls back to
  // the current model's brand (when it belongs to the active connection) — so
  // the pane opens on the selection without a state-syncing effect.
  const [brandTab, setBrandTab] = useState<string | null>(null);
  const defaultBrand = useMemo(() => {
    if (brandGroups.length === 0) return null;
    const cur = models.find((m) => refOf(m) === currentRef);
    if (cur && (!byConnection || cur.configId === activeConn)) return groupOf(cur);
    return brandGroups[0].key;
  }, [brandGroups, models, currentRef, byConnection, activeConn]);
  const activeBrand = brandTab ?? defaultBrand;

  // Pane: global search groups by its top dimension (connection, else brand);
  // the Featured tab and a picked brand both scope to the active connection.
  const sections = useMemo<GroupEntry[]>(() => {
    if (searching) return byConnection ? buildConnectionGroups(searchResults) : buildGroups(searchResults);
    if (activeBrand === FEATURED_TAB) return buildGroups(scoped.filter((m) => m.featured));
    return buildGroups(scoped.filter((m) => groupOf(m) === activeBrand));
  }, [searching, searchResults, scoped, activeBrand, byConnection]);

  // Multi-group views need sticky headers; a single brand's pane names itself.
  const showHeaders = searching || activeBrand === FEATURED_TAB;

  // Flatten the visible models for keyboard navigation + active-index math.
  const visible = useMemo(() => sections.flatMap((s) => s.models), [sections]);
  const indexMap = useMemo(() => new Map(visible.map((m, i) => [refOf(m), i])), [visible]);

  // Switching connection resets the brand to that connection's default.
  const pickConn = (next: string) => { onSearch(""); onActiveIndex(0); setConnTab(next); setBrandTab(null); };
  const pickBrand = (next: string) => { onSearch(""); onActiveIndex(0); setBrandTab(next); };

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

        {sections.map(({ key, group, icon, models: groupModels }) => (
          <div key={key}>
            {showHeaders && (
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 backdrop-blur-sm px-3 py-1.5 border-b border-border/50">
                <BrandIcon slug={icon} size={12} />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{group}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">{groupModels.length}</span>
              </div>
            )}

            {groupModels.map((model) => {
              const ref = refOf(model);
              const globalIdx = indexMap.get(ref) ?? -1;
              const isActive = globalIdx === activeIndex;
              const isCurrent = ref === currentRef;
              return (
                <button
                  key={ref}
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
                  <PriceMeter model={model} />
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
  const showConnStrip = byConnection && connTabs.length > 1;
  const showBrandRail = brandGroups.length > 1 || hasFeatured;

  // Nothing to choose between (loading, error, a lone brand on a lone
  // connection) → just the list at full width.
  if (!showConnStrip && !showBrandRail) return right;

  const body = (
    <div className={`flex min-h-0 min-w-0 flex-1 ${orientation === "vertical" ? "flex-row" : "flex-col"}`}>
      {showBrandRail && (
        <ProviderRail
          groups={brandGroups}
          hasFeatured={hasFeatured}
          active={searching ? null : activeBrand}
          onSelect={pickBrand}
          orientation={orientation}
          labeled={false}
        />
      )}
      {right}
    </div>
  );

  if (!showConnStrip) return body;

  // Connection strip on top, brand rail + pane below.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ProviderRail
        groups={connTabs}
        hasFeatured={false}
        active={searching ? null : activeConn}
        onSelect={pickConn}
        orientation="horizontal"
        labeled
      />
      {body}
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

  // The desktop pill panel is portaled to <body> with position:fixed and
  // measured coords. It can't be `absolute`: the greeting wraps the trigger in
  // `animate-blur-rise`, whose transform makes it the visual containing block
  // and drags/clips any descendant — including absolutely-positioned ones. As a
  // body child with fixed coords it escapes that subtree and clamps to the
  // viewport cleanly (same reason the mobile overlay is portaled below).
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // The mobile picker is a full-screen overlay — Back should close it, not leave.
  useBackDismiss(open && isMobile, close);

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
      const target = e.target as Node;
      // The panel is portaled outside containerRef, so it must be excluded too —
      // otherwise clicking a model would register as an "outside" click and the
      // panel would close before the option's onClick fires.
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        (!popoverRef.current || !popoverRef.current.contains(target))
      ) {
        setOpen(false);
      }
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

  // Measure the trigger and place the fixed, viewport-clamped desktop panel
  // before paint. Recompute on resize/scroll so it tracks the trigger while open.
  useLayoutEffect(() => {
    if (!open || isMobile || variant !== "pill") {
      setPos(null);
      return;
    }
    const compute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const margin = 8;
      const gap = 4; // matches the old mt-1
      const panelH = 384; // h-96
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const width = Math.min(448 /* 28rem */, vw - margin * 2);
      const r = trigger.getBoundingClientRect();
      const left = Math.max(margin, Math.min(r.left, vw - width - margin));
      // Open downward; flip above the trigger if it would run off the bottom.
      const top = r.bottom + gap + panelH <= vh - margin
        ? r.bottom + gap
        : Math.max(margin, r.top - gap - panelH);
      setPos({ top, left, width });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, isMobile, variant]);

  const toggleOpen = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      if (!prev) { setSearch(""); setActiveIndex(0); }
      return !prev;
    });
  }, [disabled]);

  const select = useCallback(
    (model: ModelInfo) => {
      // Emit the config-scoped ref so the chat routes to the exact config; an
      // untagged model (field/credentials modes, legacy) yields its bare id.
      onChange(refOf(model));
      setOpen(false);
    },
    [onChange],
  );

  // Resolve the current selection: match the full ref first (the new tagged
  // form), then fall back to a bare/legacy id so old chats still light up.
  const currentModel =
    state.models.find((m) => refOf(m) === value) ??
    state.models.find((m) => m.id === parseModelId(value).modelId);
  const currentRef = currentModel ? refOf(currentModel) : value;
  const groupLabel = currentModel ? groupOf(currentModel) : null;
  const displayName = stripGroup(currentModel?.name || (value ? displayModelName(value) : ""), groupLabel);
  const placeholderText = placeholder ?? t("placeholder");

  const renderList = (orientation: "vertical" | "horizontal") => (
    <ModelList
      state={state}
      search={search}
      onSearch={setSearch}
      onSelect={select}
      currentRef={currentRef}
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

      {/* Field variant: anchored under its full-width trigger (forms have no
          transformed ancestor, so absolute is fine and matches the trigger width). */}
      {open && !isMobile && variant === "field" && (
        <div
          onKeyDown={(e) => { if (e.key === "Escape") close(); }}
          className="absolute top-full left-0 mt-1 z-50 flex h-96 w-[28rem] min-w-full overflow-hidden rounded-xl border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-150 max-w-[calc(100vw-1rem)]"
        >
          {renderList("vertical")}
        </div>
      )}

      {/* Pill variant: portaled to <body> with fixed coords so the greeting's
          animate-blur-rise transform can't drag or clip it. */}
      {open && !isMobile && variant === "pill" && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          onKeyDown={(e) => { if (e.key === "Escape") close(); }}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
          className="z-50 flex h-96 overflow-hidden rounded-xl border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-150"
        >
          {renderList("vertical")}
        </div>,
        document.body,
      )}

      {open && isMobile && typeof document !== "undefined" && createPortal(
        // Portaled to <body>: rendered inline, an animated/transformed ancestor
        // (the greeting's blur-rise) becomes the containing block for this
        // `fixed` overlay, so `inset-0` no longer means the viewport and the
        // background fails to cover the page. As a direct body child it spans
        // the full screen again.
        <div
          onKeyDown={(e) => { if (e.key === "Escape") close(); }}
          className="fixed inset-0 z-50 flex flex-col bg-background"
        >
          <div className="flex items-center justify-between border-b px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <span className="text-sm font-medium">{t("selectModel")}</span>
            <button onClick={close} aria-label={t("close")} className="rounded-md p-1 hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-1 flex-col min-h-0">{renderList("horizontal")}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
