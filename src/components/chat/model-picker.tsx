"use client";

import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useId, createElement } from "react";
import { createPortal } from "react-dom";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
import { useTranslations } from "next-intl";
import { Search, ChevronDown, X, Eye, Brain, Star, Loader2, KeyRound, AlertCircle, FileText, AudioLines, Video, SlidersHorizontal, Sparkles, Layers } from "lucide-react";
import { iconForSlug } from "./provider-icons";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { parseModelId, splitModelRef, displayModelName, encodeModelRef, acceptsNativeFile, PROVIDER_META, type ProviderName, type Modality } from "@/lib/providers/registry";
import type { ModelInfo } from "@/app/api/models/route";
import { customModelOption } from "@/lib/providers/custom-model";

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

const MODALITY_MIME: Record<Modality, string> = {
  image: "image/png", pdf: "application/pdf", audio: "audio/mpeg", video: "video/mp4",
};

/** Whether THIS model, on its OWNING CONNECTION, will actually take a file of the
 *  given modality as a native inline part — the single source of truth, shared
 *  with the runner via `acceptsNativeFile`. OpenRouter trusts the catalog's
 *  per-model `input_modalities`; every other connection falls back to its static
 *  caps (the API has no per-model standard). So a badge never promises a modality
 *  the connection won't deliver. */
function modelAcceptsModality(m: ModelInfo, mod: Modality): boolean {
  const provider = m.configProvider ?? "";
  // Trust the catalog's per-model modalities for ANY connection (OpenRouter's
  // input_modalities, LiteLLM's supported_modalities/flags, applied to direct
  // providers too). `acceptsNativeFile` still hard-gates by SDK transport reality
  // (video → Google only, PDF → always native on OpenRouter, etc.); falls back to
  // the provider's static caps when the catalog doesn't know the model.
  return acceptsNativeFile(MODALITY_MIME[mod], provider, m.capabilities?.input ?? null);
}

function Caps({ model }: { model: ModelInfo }) {
  const t = useTranslations("chat.model");
  const caps = model.capabilities;
  const hasPdf = modelAcceptsModality(model, "pdf");
  const hasAudio = modelAcceptsModality(model, "audio");
  const hasVideo = modelAcceptsModality(model, "video");
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
        className="shrink-0 text-[11px] font-medium leading-none text-emerald-600 dark:text-emerald-400"
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

// ── Filters ────────────────────────────────────────────────────────────────
//
// Plain-language capability filters — the answer to "which of these can actually
// hear a voice note / read a PDF". Phrased for non-technical staff (no "modality"
// jargon); AND semantics, so stacking two narrows to models that do both.

type FilterKey = "vision" | "pdf" | "audio" | "video" | "reasoning" | "free";
const FILTER_KEYS: FilterKey[] = ["vision", "pdf", "audio", "video", "reasoning", "free"];
const FILTER_ICON: Record<FilterKey, typeof Eye> = {
  vision: Eye, pdf: FileText, audio: AudioLines, video: Video, reasoning: Brain, free: Sparkles,
};

function modelMatchesFilter(m: ModelInfo, key: FilterKey): boolean {
  switch (key) {
    case "vision": return !!m.capabilities?.vision;
    // Attachment modalities are gated by the connection, not just the model —
    // filtering "Audio" must only surface models that will actually hear it here.
    case "pdf": return modelAcceptsModality(m, "pdf");
    case "audio": return modelAcceptsModality(m, "audio");
    case "video": return modelAcceptsModality(m, "video");
    case "reasoning": return !!m.capabilities?.reasoning;
    case "free": return isFreeModel(m);
  }
}

/** AND over the active filters — empty set matches everything. */
function matchesFilters(m: ModelInfo, active: Set<FilterKey>): boolean {
  for (const k of active) if (!modelMatchesFilter(m, k)) return false;
  return true;
}

/** The collapsible filter chip row. Hidden until the user opens it (a quiet
 *  funnel toggle in the search bar) so the default view stays calm. */
function FilterBar({
  active, onToggle, onClear,
}: {
  active: Set<FilterKey>;
  onToggle: (k: FilterKey) => void;
  onClear: () => void;
}) {
  const t = useTranslations("chat.model");
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
      {FILTER_KEYS.map((k) => {
        const on = active.has(k);
        const Icon = FILTER_ICON[k];
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(k)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
              on
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(`filter.${k}`)}
          </button>
        );
      })}
      {active.size > 0 && (
        <button type="button" onClick={onClear} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
          {t("filter.clear")}
        </button>
      )}
    </div>
  );
}

/** A small "which connection" tag shown on each search result when two or more
 *  connections are aggregated — so the same model served by two providers is
 *  never ambiguous (the brand glyph alone can't tell them apart). */
function ConnChip({ icon, label }: { icon?: string | null; label?: string | null }) {
  if (!label) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/80">
      <BrandIcon slug={icon} size={11} />
      <span className="hidden max-w-24 truncate sm:inline">{label}</span>
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
          // The server's error is a locale-less constant — treat it as a flag
          // and render the localized message.
          error: data.error ? loadErrorMsg : null,
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
            // Keep whatever already loaded; else, when there's a current selection
            // to preserve, synthesize a tool-capable stand-in (so the user keeps —
            // and can re-pick — it through a transient failure). With NO current
            // value (first-run setup / "add provider"), synthesizing a row would
            // render a bogus, selectable "select model" entry and HIDE the error —
            // so leave the list empty and let the error state surface honestly.
            models: s.models.length
              ? s.models
              : fallbackValue
                ? [{ id: fallbackValue, name: displayModelName(fallbackValue), provider: "", context: 0, pricing: { prompt: 0, completion: 0 }, capabilities: { vision: false, tools: true, reasoning: false } }]
                : [],
            loading: false,
            error: loadErrorMsg,
            syncing: false,
          }));
          // The effect only re-runs when the credentials change, so a network blip
          // would otherwise strand the picker on this error forever. The common
          // cause on first run is the origin being briefly unreachable — the page
          // rendered, but the API isn't answering yet during boot/redeploy (the
          // very gap the offline service worker exists for). Retry in the
          // background so the list fills in on its own once the server responds.
          retry = setTimeout(load, 4000);
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

// "All" — a synthetic tab on both rails: on the connection strip it lifts the
// per-connection scoping (every connection at once); on the brand rail it shows
// every brand grouped together. Lets the user browse the whole set without
// searching; rows then carry connection chips so nothing is ambiguous.
const ALL_TAB = "__all__";

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
  hasAll,
  active,
  onSelect,
  orientation,
  labeled,
}: {
  groups: GroupEntry[];
  hasFeatured: boolean;
  hasAll?: boolean;
  active: string | null;
  onSelect: (tab: string) => void;
  orientation: "vertical" | "horizontal";
  labeled: boolean;
}) {
  const t = useTranslations("chat.model");
  const vertical = orientation === "vertical";

  // Each tab is a tooltip trigger — our own instant tooltip (the native `title`
  // takes ~700ms to appear, too slow for a glyph-only rail where the name is the
  // only label). Glyph-only rails always need it; labeled tabs use it as a
  // fallback when the name is truncated.
  const item = (key: string, title: string, glyph: React.ReactNode) => {
    const isActive = active === key;
    const activeCls = isActive
      ? "bg-background text-foreground ring-1 ring-border shadow-sm"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground";
    const btn = labeled ? (
      <button
        type="button"
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
    ) : (
      <button
        type="button"
        aria-label={title}
        aria-pressed={isActive}
        onClick={() => onSelect(key)}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors ${activeCls}`}
      >
        {glyph}
      </button>
    );
    return (
      <Tooltip key={key}>
        <TooltipTrigger render={btn} />
        <TooltipContent side={vertical ? "right" : "bottom"}>{title}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <TooltipProvider delay={300}>
      <div
        className={`flex shrink-0 gap-1 ${
          vertical
            ? `flex-col overflow-y-auto overflow-x-hidden overscroll-contain border-r p-2 ${labeled ? "w-40 items-stretch" : "items-center"}`
            : "flex-row items-center overflow-x-auto border-b p-2"
        }`}
      >
        {hasAll && item(ALL_TAB, t("all"), <Layers className="h-4 w-4" />)}
        {hasFeatured && item(FEATURED_TAB, t("featured"), <Star className="h-4 w-4" />)}
        {(hasAll || hasFeatured) && (
          <span className={vertical ? (labeled ? "my-1 h-px w-full bg-border" : "my-1 h-px w-6 bg-border") : "mx-1 h-6 w-px bg-border"} />
        )}
        {groups.map((g) => item(g.key, g.group, <BrandIcon slug={g.icon} size={18} />))}
      </div>
    </TooltipProvider>
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
  currentMissing = false,
  credentialsProvider,
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
  /** The current selection is gone (provider disconnected / model removed) —
   *  show a banner explaining why nothing is highlighted and to pick another. */
  currentMissing?: boolean;
  /** Provider of an unsaved-credentials source (the add-provider form), so a
   *  typed id can bind to it even when the listing came back empty. */
  credentialsProvider?: ProviderName;
}) {
  const t = useTranslations("chat.model");
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  const searching = search.trim().length > 0;

  // Capability filters (collapsed by default). Local to the open list — closing
  // and reopening the picker starts clean, matching the search box.
  const [filters, setFilters] = useState<Set<FilterKey>>(() => new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const toggleFilter = (k: FilterKey) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
    onActiveIndex(0);
  };
  const clearFilters = () => { setFilters(new Set()); onActiveIndex(0); };
  const passesFilter = useCallback((m: ModelInfo) => matchesFilters(m, filters), [filters]);

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

  // Models feeding the brand rail + pane: the active connection's, all of them
  // when "All connections" is picked (or a single/untagged setup makes the top
  // strip unnecessary).
  const scoped = useMemo(
    () =>
      byConnection && activeConn && activeConn !== ALL_TAB
        ? models.filter((m) => m.configId === activeConn)
        : models,
    [models, byConnection, activeConn],
  );

  // Show the per-row connection tag whenever the pane spans more than one
  // connection — global search or the "All connections" view.
  const showConnChip = byConnection && (searching || activeConn === ALL_TAB);

  // Left rail = brands of the scoped set. Built from the full scoped set so it
  // stays stable while searching/filtering.
  const brandGroups = useMemo(() => buildGroups(scoped), [scoped]);
  const hasFeatured = useMemo(() => scoped.some((m) => m.featured), [scoped]);

  // Search is global — across every connection — so a model is findable no
  // matter which tab is open. Results are a single flat list (each row carries
  // its connection chip), sorted featured-first, and narrowed by any active
  // capability filters.
  const searchResults = useMemo(() => {
    if (!searching) return [];
    const q = search.trim().toLowerCase();
    const matched = models
      .filter(
        (m) =>
          passesFilter(m) &&
          (m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            groupOf(m).toLowerCase().includes(q) ||
            (m.configLabel ?? "").toLowerCase().includes(q)),
      )
      .sort(sortFeaturedFirst);
    // A fully-qualified id the catalog doesn't list (stealth/alpha model, or one
    // newer than the last sync) is still runnable — the id passes straight through
    // to the provider. Offer it as a custom option bound to the active connection
    // when nothing matches it exactly, so it's reachable from the picker.
    if (!models.some((m) => m.id.toLowerCase() === q)) {
      // Bind a typed id to the connection whose provider matches its prefix
      // ("openrouter/…" → the OpenRouter connection), so it routes to a provider
      // that can actually serve it — not whatever tab happens to be active (which
      // produced "No available channel for openrouter/… under group <other>").
      // Fall back to the active connection, then any.
      const prefix = q.split("/")[0];
      const sample =
        models.find((m) => m.configProvider?.toLowerCase() === prefix) ??
        models.find((m) => m.configId === activeConn) ??
        models[0] ??
        // An Azure resource with zero deployments lists zero models, yet a
        // typed deployment name is the only runnable id — synthesize a
        // provider-only sample so manual entry isn't dead-ended.
        (credentialsProvider === "azure"
          ? ({
              id: "",
              name: "",
              provider: "",
              context: 0,
              pricing: { prompt: 0, completion: 0 },
              capabilities: { vision: false, tools: true, reasoning: false },
              configProvider: "azure",
            } satisfies ModelInfo)
          : undefined);
      const custom = customModelOption(search, sample);
      if (custom) return [...matched, custom];
    }
    return matched;
  }, [models, search, searching, passesFilter, activeConn, credentialsProvider]);

  // Which brand fills the pane. Until the user clicks the rail it falls back to
  // the current model's brand (when it belongs to the active connection) — so
  // the pane opens on the selection without a state-syncing effect.
  const [brandTab, setBrandTab] = useState<string | null>(null);
  const defaultBrand = useMemo(() => {
    if (brandGroups.length === 0) return null;
    // "All connections" opens on "All brands" — the whole set at once.
    if (activeConn === ALL_TAB) return ALL_TAB;
    const cur = models.find((m) => refOf(m) === currentRef);
    if (cur && (!byConnection || cur.configId === activeConn)) return groupOf(cur);
    return brandGroups[0].key;
  }, [brandGroups, models, currentRef, byConnection, activeConn]);
  const activeBrand = brandTab ?? defaultBrand;

  // Pane: search is one flat list (per-row connection chips disambiguate); the
  // Featured tab and a picked brand scope to the active connection, both narrowed
  // by the active capability filters.
  const sections = useMemo<GroupEntry[]>(() => {
    if (searching) return [{ key: "search", group: "", icon: null, models: searchResults }];
    if (activeBrand === FEATURED_TAB) return buildGroups(scoped.filter((m) => m.featured && passesFilter(m)));
    if (activeBrand === ALL_TAB) return buildGroups(scoped.filter((m) => passesFilter(m)));
    return buildGroups(scoped.filter((m) => groupOf(m) === activeBrand && passesFilter(m)));
  }, [searching, searchResults, scoped, activeBrand, passesFilter]);

  // Multi-brand panes (Featured, All) need sticky brand headers; search is a flat
  // list with per-row chips and a single brand's pane names itself.
  const showHeaders = !searching && (activeBrand === FEATURED_TAB || activeBrand === ALL_TAB);

  // Flatten the visible models for keyboard navigation + active-index math.
  const visible = useMemo(() => sections.flatMap((s) => s.models), [sections]);
  const indexMap = useMemo(() => new Map(visible.map((m, i) => [refOf(m), i])), [visible]);

  // Switching connection resets the brand to that connection's default.
  const pickConn = (next: string) => { onSearch(""); onActiveIndex(0); setConnTab(next); setBrandTab(null); };
  const pickBrand = (next: string) => { onSearch(""); onActiveIndex(0); setBrandTab(next); };

  // When a single company fills the pane (no per-group sticky headers), name it
  // up top so the user always knows which provider they're looking at. Search is
  // a cross-provider flat list, so it gets no single heading (rows carry chips).
  const paneHeading = !showHeaders && !searching ? sections[0] : null;

  const right = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {currentMissing && (
        <div className="flex items-center gap-2 border-b border-warning-border bg-warning-surface px-3 py-2 text-xs text-foreground">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning-text" />
          <span>{t("currentUnavailable")}</span>
        </div>
      )}
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
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-pressed={filtersOpen}
          aria-label={t("filter.title")}
          title={t("filter.title")}
          className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
            filtersOpen || filters.size > 0 ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {filters.size > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground tabular-nums">
              {filters.size}
            </span>
          )}
        </button>
      </div>
      {filtersOpen && <FilterBar active={filters} onToggle={toggleFilter} onClear={clearFilters} />}

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
              <span className="flex flex-col items-center gap-1.5">
                {t("noneFound")}
                {/* A model not in the catalog (a stealth/preview id, or one newer
                    than the last sync) is still usable — typing its FULL id offers
                    it as a custom option. Nudge that, since a bare word can't be
                    resolved to one. */}
                <span className="text-muted-foreground/70">{t("noneFoundHint")}</span>
              </span>
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
                  className={`group/row flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors active:bg-accent [content-visibility:auto] [contain-intrinsic-size:auto_44px] ${isActive ? "bg-accent" : ""} ${isCurrent ? "bg-accent/50" : ""}`}
                >
                  {searching ? (
                    <BrandIcon slug={model.icon} size={14} className="shrink-0 text-muted-foreground" />
                  ) : (
                    model.featured && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{stripGroup(model.name, group)}</span>
                  {/* Right meta cluster, pinned to the row's right edge so the
                      connection tag and price line up in tidy columns regardless of
                      name length. Context + capabilities reveal on hover / keyboard
                      focus (the funnel filters cover "only models that hear audio");
                      the price sits last and stays put whether or not caps show. */}
                  <span className="ml-auto flex shrink-0 items-center gap-3">
                    <span
                      className={`flex items-center gap-2 text-[11px] text-muted-foreground transition-opacity duration-150 group-hover/row:opacity-100 ${
                        isActive ? "opacity-100" : "opacity-0"
                      }`}
                    >
                      {model.context > 0 && (
                        <span className="tabular-nums" title={t("context")}>{formatContext(model.context)}</span>
                      )}
                      <Caps model={model} />
                    </span>
                    {showConnChip && <ConnChip icon={model.configIcon} label={model.configLabel} />}
                    {isCurrent && (
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">{t("active")}</span>
                    )}
                    <PriceMeter model={model} />
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
          hasAll={brandGroups.length > 1}
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
        hasAll
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
  /** Show a reset affordance (field variant) that clears the selection back to
   *  the empty value — used where an empty value is meaningful, e.g. a project's
   *  "use the global default model". */
  clearable?: boolean;
  /** Reports whether `value` resolves to a real, currently-serveable model once
   *  the list has settled. Lets the parent (the chat composer) block sending to
   *  a model whose provider was disconnected or whose entry was removed. While
   *  the list is still loading `settled` is false — callers must not block yet.
   *  Also carries the resolved model's provider and native input modalities, so
   *  the composer can warn when a staged attachment won't be read natively. */
  onResolved?: (status: {
    settled: boolean;
    available: boolean;
    provider?: string;
    inputModalities?: Modality[] | null;
  }) => void;
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
  clearable,
  onResolved,
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
  // Measuring layout (getBoundingClientRect) then writing the result to state is
  // exactly what useLayoutEffect is for — the set-state-in-effect rule is a false
  // positive here (there's no external system to read this from during render).
  useLayoutEffect(() => {
    if (!open || isMobile || variant !== "pill") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears measured position on close; measurement must live in useLayoutEffect
      setPos(null);
      return;
    }
    const compute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const margin = 8;
      const gap = 4; // matches the old mt-1
      const panelH = 480; // h-[30rem]
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const width = Math.min(576 /* 36rem */, vw - margin * 2);
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

  // Field panel placement — measured on open (and on resize/scroll while open).
  // The panel prefers opening downward; when the space below the trigger can't
  // fit it and above is roomier, it flips up. Either way its height is capped
  // to the space actually visible: not just the viewport, but the tightest
  // overflow ancestor (a settings pane's scroller, a dialog body) — an
  // absolutely-positioned panel poking above a scroller's top edge is clipped
  // with no way to scroll to it, so viewport-only math rendered a decapitated
  // panel whose search bar and list head were cut off.
  const [fieldPos, setFieldPos] = useState<{ up: boolean; maxH: number; maxW: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || isMobile || variant !== "field") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears measured placement on close; measurement must live in useLayoutEffect
      setFieldPos(null);
      return;
    }
    const compute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const margin = 8;
      const gap = 4; // matches mt-1/mb-1
      const panelH = 480; // the preferred h-[30rem]
      let clipTop = 0;
      let clipBottom = document.documentElement.clientHeight;
      let clipRight = document.documentElement.clientWidth;
      for (let el = trigger.parentElement; el; el = el.parentElement) {
        const st = getComputedStyle(el);
        const cr = el.getBoundingClientRect();
        if (st.overflowY !== "visible") {
          clipTop = Math.max(clipTop, cr.top);
          clipBottom = Math.min(clipBottom, cr.bottom);
        }
        if (st.overflowX !== "visible") clipRight = Math.min(clipRight, cr.right);
      }
      const r = trigger.getBoundingClientRect();
      const below = clipBottom - r.bottom - gap - margin;
      const above = r.top - clipTop - gap - margin;
      const up = below < panelH && above > below;
      setFieldPos({
        up,
        maxH: Math.round(Math.min(panelH, Math.max(240, up ? above : below))),
        maxW: Math.round(Math.max(240, clipRight - r.left - margin)),
      });
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

  // A typed, off-catalog model (a stealth/preview id) isn't in state.models, so
  // remember the one just selected — otherwise the pill flags the chat
  // "unavailable" the moment it's picked, even though it routes and runs fine.
  const [customModel, setCustomModel] = useState<ModelInfo | null>(null);

  const select = useCallback(
    (model: ModelInfo) => {
      // Emit the config-scoped ref so the chat routes to the exact config; an
      // untagged model (field/credentials modes, legacy) yields its bare id.
      if (!state.models.some((m) => refOf(m) === refOf(model))) setCustomModel(model);
      onChange(refOf(model));
      setOpen(false);
    },
    [onChange, state.models],
  );

  // A persisted selection can be an off-catalog id — a stealth/preview model the
  // admin typed as the connection default, which routes and runs fine but is
  // absent from the provider's catalog. It never passed through `select` this
  // session, so `customModel` doesn't cover it; without recovery a brand-new chat
  // opening on such a default false-flags the model as gone and blocks the
  // composer. As long as its connection is still live (some loaded model shares
  // its configId), trust it and synthesize a stand-in bound to that connection.
  // Only when NO loaded model shares its config is it genuinely gone (the
  // connection was removed) — the case the missing flag is meant to catch.
  const recoveredModel = useMemo(() => {
    if (!value || state.models.length === 0) return undefined;
    if (state.models.some((m) => refOf(m) === value || m.id === parseModelId(value).modelId)) return undefined;
    const { configId, modelId } = splitModelRef(value);
    const sample = configId ? state.models.find((m) => m.configId === configId) : undefined;
    if (!sample) return undefined;
    const recovered: ModelInfo = {
      id: modelId,
      name: modelId,
      provider: sample.provider ?? "Custom",
      context: 0,
      pricing: { prompt: 0, completion: 0 },
      group: sample.group ?? sample.provider ?? null,
      icon: sample.configIcon ?? sample.icon ?? null,
      capabilities: { vision: false, tools: true, reasoning: false },
      featured: false,
      configId: sample.configId,
      configLabel: sample.configLabel,
      configIcon: sample.configIcon,
      configProvider: sample.configProvider,
    };
    return recovered;
  }, [value, state.models]);

  // Resolve the current selection: match the full ref first (the new tagged
  // form), then fall back to a bare/legacy id so old chats still light up, then
  // the just-typed custom model so an off-catalog pick isn't shown as missing,
  // then a persisted off-catalog default whose connection is still live.
  const currentModel =
    state.models.find((m) => refOf(m) === value) ??
    state.models.find((m) => m.id === parseModelId(value).modelId) ??
    (customModel && refOf(customModel) === value ? customModel : undefined) ??
    recoveredModel;
  const currentRef = currentModel ? refOf(currentModel) : value;
  const groupLabel = currentModel ? groupOf(currentModel) : null;
  const displayName = stripGroup(currentModel?.name || (value ? displayModelName(value) : ""), groupLabel);
  const placeholderText = placeholder ?? t("placeholder");

  // The list loaded fine and has models, but ours isn't among them → the model's
  // provider was disconnected or its catalog entry was removed. We only claim
  // this once the list has genuinely settled (not loading/syncing/awaiting a
  // key) and came back non-empty, so a transient empty/error state never
  // false-flags a model as gone. On a fetch error useModels injects a fallback
  // entry for `value`, so currentModel still resolves and this stays false.
  const settled = !state.loading && !state.syncing && !state.needsKey;
  const modelMissing = settled && !state.error && state.models.length > 0 && !!value && !currentModel;

  const resolvedProvider = currentModel?.configProvider;
  const resolvedInput = currentModel?.capabilities?.input ?? null;
  useEffect(() => {
    onResolved?.({ settled, available: !modelMissing, provider: resolvedProvider, inputModalities: resolvedInput });
  }, [settled, modelMissing, resolvedProvider, resolvedInput, onResolved]);

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
      currentMissing={modelMissing}
      credentialsProvider={source.mode === "credentials" ? source.provider : undefined}
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
          title={modelMissing ? t("unavailable") : undefined}
          className="flex h-9 items-center gap-2.5 px-3 text-sm hover:text-foreground transition-colors"
        >
          <span className={`flex h-6 w-6 items-center justify-center rounded-md bg-muted shrink-0 ${modelMissing ? "opacity-50" : ""}`}>
            <BrandIcon slug={currentModel?.icon} size={14} />
          </span>
          {/* Until the catalog resolves the friendly name, show a skeleton rather
              than the raw model id — it would otherwise flash "glm-5.2" before
              snapping to "GLM 5.2". */}
          {state.loading && !currentModel ? (
            <span className="h-4 w-28 animate-pulse rounded-md bg-muted" />
          ) : (
            <span className="flex items-baseline gap-1.5 min-w-0">
              <span className={`truncate max-w-52 font-medium ${modelMissing ? "text-muted-foreground" : "text-foreground"}`}>{displayName || placeholderText}</span>
              {/* The model's provider is gone — a warning dot flags it without
                  hiding which model this used to be (the name stays). Uses the
                  semantic warning token so it matches the unavailable banner. */}
              {modelMissing && (
                <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-warning-text" aria-label={t("unavailable")} />
              )}
              {currentModel && currentModel.context > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums hidden md:inline" title={t("context")}>{formatContext(currentModel.context)}</span>
              )}
              {/* Shared-key chip: shown when the whole offering is the shared key,
                  or (in a mixed own+shared picker) when the SELECTED model runs on
                  a shared connection. */}
              {(state.isShared || currentModel?.configShared) && (
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
          className={`flex h-9 w-full items-center gap-2 rounded-md border bg-transparent px-3 text-sm transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
            clearable && value && !state.loading ? "pr-9" : ""
          }`}
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

      {/* Reset-to-empty affordance (field variant). An empty value is meaningful
          here — it falls back to the global default — so let the user undo a pick
          without hunting for it in the list. Sits right of the chevron (the
          trigger reserves pr-9 for it). */}
      {clearable && variant === "field" && value && !state.loading && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange(""); }}
          aria-label={t("clearSelection")}
          title={t("clearSelection")}
          className="absolute right-2.5 top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Field variant: anchored to its full-width trigger, flipping above it
          when the viewport has more room there (see the fieldPos measurement). */}
      {open && !isMobile && variant === "field" && fieldPos && (
        <div
          onKeyDown={(e) => { if (e.key === "Escape") close(); }}
          style={{ height: fieldPos.maxH, maxWidth: fieldPos.maxW }}
          className={`absolute left-0 z-50 flex w-[34rem] min-w-full overflow-hidden rounded-xl border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-150 ${
            fieldPos.up ? "bottom-full mb-1" : "top-full mt-1"
          }`}
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
          className="z-50 flex h-[30rem] overflow-hidden rounded-xl border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-150"
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
