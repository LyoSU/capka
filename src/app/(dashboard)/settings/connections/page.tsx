"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import {
  SettingsPage,
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  SettingsEmpty,
  SettingsError,
} from "@/components/settings/shell";
import { Loader2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ConnectionRow, type ProviderConfig } from "@/components/settings/connection-row";
import { AddProviderDialog } from "@/components/settings/add-provider-dialog";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useSetting } from "@/hooks/use-setting";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";

export default function ConnectionsPage() {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  const isAdmin = useIsAdmin();
  const minCtx = useSetting("model_min_context", String(DEFAULT_MODEL_MIN_CONTEXT));
  const maxPrice = useSetting("model_max_price", "0");
  const maxCtxTokens = useSetting("max_context_tokens", "0");
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [resyncing, setResyncing] = useState(false);

  // A live mirror of `configs`, so drag/keyboard reorder can read the current
  // order without threading it through state-updater side effects.
  const configsRef = useRef<ProviderConfig[]>([]);
  useEffect(() => { configsRef.current = configs; }, [configs]);

  const fetchConfigs = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/settings/providers");
      if (res.ok) setConfigs(await res.json());
      else setError(t("loadError"));
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // The default connection (a brand-new chat's cold-start model comes from it) is
  // the first ENABLED config — exactly what resolveProviderConfig picks server-side.
  const defaultId = configs.find((c) => c.isActive)?.id ?? null;

  // --- Reorder (pointer + keyboard), library-free ------------------------------
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const dragId = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const persistOrder = useCallback(
    async (ids: string[]) => {
      const res = await fetch("/api/settings/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: ids }),
      });
      // On failure, snap back to the server's truth rather than leave a lie on screen.
      if (!res.ok) {
        toast.error(t("reorderError"));
        fetchConfigs();
      }
    },
    [t, fetchConfigs],
  );

  function startDrag(id: string, e: PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragId.current = id;
    setDraggingId(id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  // Live swap: as the pointer crosses a neighbour's midpoint, move the dragged row
  // into that slot. The captured handle receives every move event, so we route by
  // clientY against each row's rect rather than tracking hover targets.
  function dragMove(e: PointerEvent) {
    const id = dragId.current;
    if (!id) return;
    const y = e.clientY;
    setConfigs((prev) => {
      const from = prev.findIndex((c) => c.id === id);
      if (from < 0) return prev;
      let to = from;
      for (let i = 0; i < prev.length; i++) {
        const el = rowRefs.current.get(prev[i].id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        if (i < from && y < mid) { to = i; break; }
        if (i > from && y > mid) { to = i; }
      }
      if (to === from) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function endDrag(e: PointerEvent) {
    if (!dragId.current) return;
    dragId.current = null;
    setDraggingId(null);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    persistOrder(configsRef.current.map((c) => c.id));
  }

  function handleHandleKey(id: string, e: KeyboardEvent) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = configsRef.current;
    const from = cur.findIndex((c) => c.id === id);
    const to = from + (e.key === "ArrowUp" ? -1 : 1);
    if (from < 0 || to < 0 || to >= cur.length) return;
    const next = [...cur];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setConfigs(next);
    persistOrder(next.map((c) => c.id));
  }

  // --- Per-connection mutations ------------------------------------------------
  const handleToggle = async (id: string, enabled: boolean) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    if (res.ok) {
      setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, isActive: enabled } : c)));
      toast.success(enabled ? t("enabledToast") : t("disabledToast"));
    } else {
      toast.error(t("toggleError"));
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/settings/providers?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      setConfigs((prev) => prev.filter((c) => c.id !== id));
      setDeleteId(null);
      toast.success(t("removed"));
    } else {
      toast.error(t("removeError"));
    }
  };

  const handleUpdateModel = async (id: string, model: string) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, defaultModel: model }),
    });
    if (res.ok) {
      setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, defaultModel: model } : c)));
      toast.success(t("modelUpdated"));
    } else {
      toast.error(t("modelUpdateError"));
    }
  };

  // Persist a custom name/glyph. Local state is updated optimistically by the
  // caller; this just saves and surfaces failures.
  const saveMeta = async (id: string, patch: { label?: string | null; iconSlug?: string | null }) => {
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    if (!res.ok) toast.error(t("toggleError"));
  };

  const handleLabelChange = (id: string, label: string) =>
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)));
  const handleLabelCommit = (id: string) =>
    saveMeta(id, { label: configsRef.current.find((c) => c.id === id)?.label });
  const handleIconChange = (id: string, slug: string | null) => {
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, iconSlug: slug } : c)));
    saveMeta(id, { iconSlug: slug });
  };

  const handleToggleShared = async (id: string, shared: boolean) => {
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, shared } : c)));
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, shared }),
    });
    if (!res.ok) {
      setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, shared: !shared } : c)));
      toast.error(t("toggleError"));
    }
  };

  // Switch an existing OpenAI connection's wire transport. "auto" persists as
  // null; the change takes effect on the next turn (model is re-resolved each run).
  const handleUpdateApiStyle = async (id: string, style: string | null) => {
    const value = !style || style === "auto" ? null : style;
    setConfigs((prev) => prev.map((c) => (c.id === id ? { ...c, apiStyle: value } : c)));
    const res = await fetch("/api/settings/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, apiStyle: value }),
    });
    if (res.ok) toast.success(tc("saved"));
    else toast.error(t("toggleError"));
  };

  // --- Model filter (admin, global governance) ---------------------------------
  const contextLabel = (val: string) => {
    const n = parseInt(val, 10);
    if (!n || n <= 0) return "";
    if (n >= 1_000_000) return t("tokensM", { value: (n / 1_000_000).toFixed(1) });
    return t("tokensK", { value: (n / 1_000).toFixed(0) });
  };
  const saveMinCtx = async () => {
    const ok = await minCtx.persist(minCtx.value);
    if (ok) toast.success(tc("saved"));
    else toast.error(t("minContextSaveFailed"));
  };
  const priceLabel = (val: string) => {
    const n = parseFloat(val);
    if (!n || n <= 0) return t("noPriceCap");
    return t("perMillion", { value: n % 1 === 0 ? n.toFixed(0) : n.toFixed(2) });
  };
  const saveMaxPrice = async () => {
    const ok = await maxPrice.persist(maxPrice.value);
    if (ok) toast.success(tc("saved"));
    else toast.error(t("maxPriceSaveFailed"));
  };
  const ctxTokensLabel = (val: string) => {
    const n = parseInt(val, 10);
    if (!n || n <= 0) return t("noContextCap");
    return contextLabel(val);
  };
  const saveMaxCtxTokens = async () => {
    const ok = await maxCtxTokens.persist(maxCtxTokens.value);
    if (ok) toast.success(tc("saved"));
    else toast.error(t("maxContextTokensSaveFailed"));
  };
  const handleResync = async () => {
    setResyncing(true);
    try {
      const res = await fetch("/api/admin/models/resync", { method: "POST" });
      if (!res.ok) throw new Error();
      const { openrouter } = await res.json();
      toast.success(t("resyncDone", { count: openrouter ?? 0 }));
    } catch {
      toast.error(t("resyncFailed"));
    } finally {
      setResyncing(false);
    }
  };

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      {error && <SettingsError message={error} />}

      {/* Provider list — compact, draggable rows that expand to full settings.
          "Add" sits on the section's title line, where every other list on
          these pages keeps its one action. */}
      <SettingsSection
        title={t("listTitle")}
        action={<AddProviderDialog isAdmin={isAdmin} onAdded={fetchConfigs} />}
      >
        <div className="divide-y">
          {loading &&
            Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 py-3.5">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="ml-auto h-4 w-16" />
              </div>
            ))}

          {!loading && configs.length === 0 && (
            <SettingsEmpty icon={Unplug} title={t("empty")} hint={t("emptyHint")} />
          )}

          {!loading &&
            configs.map((c) => (
              <ConnectionRow
                key={c.id}
                config={c}
                isAdmin={isAdmin}
                isDefault={c.id === defaultId}
                expanded={expandedId === c.id}
                onExpandedChange={(open) => setExpandedId(open ? c.id : null)}
                dragging={draggingId === c.id}
                dragHandleProps={{
                  onPointerDown: (e) => startDrag(c.id, e),
                  onPointerMove: dragMove,
                  onPointerUp: endDrag,
                  onKeyDown: (e) => handleHandleKey(c.id, e),
                }}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(c.id, el);
                  else rowRefs.current.delete(c.id);
                }}
                onToggle={(enabled) => handleToggle(c.id, enabled)}
                onDelete={() => setDeleteId(c.id)}
                onUpdateModel={(model) => handleUpdateModel(c.id, model)}
                onLabelChange={(label) => handleLabelChange(c.id, label)}
                onLabelCommit={() => handleLabelCommit(c.id)}
                onIconChange={(slug) => handleIconChange(c.id, slug)}
                onToggleShared={(shared) => handleToggleShared(c.id, shared)}
                onUpdateApiStyle={(style) => handleUpdateApiStyle(c.id, style)}
              />
            ))}
        </div>
      </SettingsSection>

      {/* Model filter — global governance, admin only. Lives here because it
          shapes which models the picker offers across every connection. */}
      {isAdmin && !minCtx.loading && (
        <SettingsSection title={t("modelFilter")} description={t("modelFilterDesc")}>
          <SettingsGroup>
            {/* Number, unit, Save — one row per limit, control on the right like
                every other row. The unit label reads the number back in words
                ("100k tokens", "no cap"), which is the part a non-technical
                admin actually checks. */}
            {([
              ["min-context", minCtx, t("minContext"), t("minContextHint"), contextLabel(minCtx.value), saveMinCtx, { placeholder: "100000" }],
              ["max-price", maxPrice, t("maxPrice"), t("maxPriceHint"), priceLabel(maxPrice.value), saveMaxPrice, { min: "0", step: "1", placeholder: "25" }],
              ["max-context-tokens", maxCtxTokens, t("maxContextTokens"), t("maxContextTokensHint"), ctxTokensLabel(maxCtxTokens.value), saveMaxCtxTokens, { min: "0", step: "1000", placeholder: "0" }],
            ] as const).map(([id, s, title, hint, unit, save, attrs]) => (
              <SettingsRow key={id} id={id} labelFor={`${id}-input`} title={title} hint={hint}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Input
                    id={`${id}-input`}
                    type="number"
                    value={s.value}
                    onChange={(e) => s.update(e.target.value)}
                    className="h-8 w-32 text-right tabular-nums"
                    {...attrs}
                  />
                  <span className="text-[13px] text-muted-foreground">{unit}</span>
                  {s.dirty && (
                    <Button size="sm" onClick={save} className="animate-step-in ml-auto">{tc("save")}</Button>
                  )}
                </div>
              </SettingsRow>
            ))}

            <SettingsRow
              title={t("resyncModels")}
              hint={t("resyncModelsHint")}
              control={
                <Button size="sm" variant="outline" onClick={handleResync} disabled={resyncing}>
                  {resyncing && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("resyncModelsButton")}
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={() => deleteId && handleDelete(deleteId)}
        title={t("confirmRemoveTitle")}
        description={t("confirmRemoveDesc")}
      />
    </SettingsPage>
  );
}
