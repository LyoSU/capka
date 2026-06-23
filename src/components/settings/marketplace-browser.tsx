"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plus, Trash2, RefreshCw, Download, Check, Search, ArrowUpCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PluginIcon } from "@/components/plugin-icon";
import MembersInstallToggle from "@/components/settings/members-install-toggle";

interface Marketplace {
  id: string;
  url: string;
  name: string;
  owner: string | null;
  pluginCount: number;
}
interface CatalogItem {
  name: string;
  description: string;
  author: string | null;
  category: string | null;
  homepage: string | null;
  installable: boolean;
  installed: boolean;
}

export function MarketplaceBrowser() {
  const t = useTranslations("settings.marketplace");
  const [markets, setMarkets] = useState<Marketplace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const loadMarkets = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/marketplaces");
      if (res.ok) {
        const list: Marketplace[] = (await res.json()).marketplaces ?? [];
        setMarkets(list);
        setSelected((cur) => cur ?? list[0]?.id ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    loadMarkets();
  }, [loadMarkets]);

  const loadCatalog = useCallback(async (id: string) => {
    setCatalogLoading(true);
    try {
      const res = await fetch(`/api/admin/marketplaces/catalog?id=${encodeURIComponent(id)}`);
      if (res.ok) setCatalog((await res.json()).items ?? []);
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  useEffect(() => {
    if (selected) loadCatalog(selected);
  }, [selected, loadCatalog]);

  const addMarket = async () => {
    if (!addUrl.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/admin/marketplaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: addUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(t("added"));
        setAddUrl("");
        await loadMarkets();
        setSelected(data.id);
      } else toast.error(data.error || t("addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const refresh = async (id: string) => {
    const res = await fetch("/api/admin/marketplaces/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      toast.success(t("refreshed"));
      await loadMarkets();
      if (selected === id) loadCatalog(id);
    } else toast.error(t("refreshFailed"));
  };

  const removeMarket = async (id: string) => {
    const res = await fetch(`/api/admin/marketplaces?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      toast.success(t("removed"));
      if (selected === id) setSelected(null);
      await loadMarkets();
    } else toast.error(t("removeFailed"));
  };

  const install = async (pluginName: string) => {
    if (!selected) return;
    setBusy(pluginName);
    try {
      const res = await fetch("/api/admin/marketplaces/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplaceId: selected, pluginName }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const m = data.manifest ?? {};
        toast.success(t("installed", { skills: (m.skills ?? []).length, connectors: (m.connectors ?? []).length }));
        for (const note of m.notes ?? []) toast.message(note);
        await loadCatalog(selected);
      } else toast.error(data.error || t("installFailed"));
    } finally {
      setBusy(null);
    }
  };

  const update = async (pluginName: string) => {
    if (!selected) return;
    setBusy(pluginName);
    try {
      const res = await fetch("/api/admin/marketplaces/install", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplaceId: selected, pluginName }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const m = data.manifest ?? {};
        toast.success(t("updated", { skills: (m.skills ?? []).length, connectors: (m.connectors ?? []).length }));
        await loadCatalog(selected);
      } else toast.error(data.error || t("updateFailed"));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (pluginName: string) => {
    if (!selected) return;
    setBusy(pluginName);
    try {
      const res = await fetch(
        `/api/admin/marketplaces/install?marketplaceId=${encodeURIComponent(selected)}&pluginName=${encodeURIComponent(pluginName)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        toast.success(t("uninstalled"));
        await loadCatalog(selected);
      } else toast.error(t("uninstallFailed"));
    } finally {
      setBusy(null);
    }
  };

  // Search across the selected marketplace's catalog, then group by category.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? catalog.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q) ||
            (c.author?.toLowerCase().includes(q) ?? false),
        )
      : catalog;
    const byCat = new Map<string, CatalogItem[]>();
    for (const c of filtered) {
      const cat = c.category?.trim() || t("uncategorized");
      (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(c);
    }
    return [...byCat.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, items]) => ({ cat, items: items.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [catalog, query, t]);

  return (
    <div className="space-y-5">
      <MembersInstallToggle />

      {/* Add a marketplace */}
      <div className="flex gap-2">
        <Input
          placeholder={t("urlPlaceholder")}
          value={addUrl}
          onChange={(e) => setAddUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addMarket()}
        />
        <Button size="sm" onClick={addMarket} disabled={adding || !addUrl.trim()}>
          {adding ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
          {t("add")}
        </Button>
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && markets.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      )}

      {/* Marketplace selector */}
      {markets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {markets.map((m) => (
            <div
              key={m.id}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-sm ${
                selected === m.id ? "bg-accent font-medium" : "text-muted-foreground"
              }`}
            >
              <button onClick={() => setSelected(m.id)} className="flex items-center gap-1.5">
                {m.name} <span className="text-xs text-muted-foreground">({m.pluginCount})</span>
              </button>
              <button onClick={() => refresh(m.id)} aria-label={t("refresh")} className="ml-1 text-muted-foreground hover:text-foreground">
                <RefreshCw className="h-3 w-3" />
              </button>
              <button onClick={() => removeMarket(m.id)} aria-label={t("remove")} className="text-muted-foreground hover:text-destructive">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Search */}
      {markets.length > 0 && catalog.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-8" />
        </div>
      )}

      {/* Catalog grouped by category */}
      {catalogLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {!catalogLoading &&
        selected &&
        sections.map(({ cat, items }) => (
          <div key={cat} className="space-y-2">
            <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{cat}</p>
            {items.map((c) => (
              <div key={c.name} className="flex items-start justify-between gap-4 rounded-lg border bg-card p-3">
                <div className="flex flex-1 items-start gap-3">
                  <PluginIcon name={c.name} homepage={c.homepage} size={40} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{c.name}</span>
                      {c.author && <span className="text-xs text-muted-foreground">{t("by", { author: c.author })}</span>}
                    </div>
                    {c.description && <p className="line-clamp-2 text-xs text-muted-foreground">{c.description}</p>}
                    {!c.installable && <p className="text-xs text-amber-600 dark:text-amber-500">{t("unsupportedSource")}</p>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {c.installed ? (
                    <>
                      <Button variant="ghost" size="sm" disabled={busy === c.name} onClick={() => update(c.name)} aria-label={t("update")}>
                        {busy === c.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy === c.name} onClick={() => uninstall(c.name)}>
                        <Check className="mr-1.5 h-4 w-4 text-emerald-600" />
                        {t("installedLabel")}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" disabled={!c.installable || busy === c.name} onClick={() => install(c.name)}>
                      {busy === c.name ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
                      {t("install")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      {!catalogLoading && selected && catalog.length > 0 && sections.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("noMatches", { query })}</p>
      )}
    </div>
  );
}
