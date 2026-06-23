"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Download, Check, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PluginIcon } from "@/components/plugin-icon";

interface Marketplace { id: string; name: string; owner: string | null }
interface CatalogItem {
  name: string;
  description: string;
  author: string | null;
  homepage: string | null;
  installable: boolean;
  installed: boolean;
}

/** Read-only marketplace browse for members: pick a marketplace, install plugins
 *  for yourself. No marketplace management (that stays admin-only). */
export default function MemberPluginBrowser() {
  const t = useTranslations("settings.marketplace");
  const [markets, setMarkets] = useState<Marketplace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/api/extensions/browse")
      .then((r) => (r.ok ? r.json() : { marketplaces: [] }))
      .then((d) => {
        const list: Marketplace[] = d.marketplaces ?? [];
        setMarkets(list);
        setSelected((cur) => cur ?? list[0]?.id ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  const loadCatalog = useCallback(async (id: string) => {
    setCatalogLoading(true);
    try {
      const r = await fetch(`/api/extensions/browse?marketplaceId=${encodeURIComponent(id)}`);
      if (r.ok) setItems((await r.json()).items ?? []);
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  useEffect(() => { if (selected) loadCatalog(selected); }, [selected, loadCatalog]);

  const install = async (name: string) => {
    if (!selected) return;
    setBusy(name);
    try {
      const r = await fetch("/api/extensions/install", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplaceId: selected, pluginName: name }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const m = d.manifest ?? {};
        toast.success(t("installed", { skills: (m.skills ?? []).length, connectors: (m.connectors ?? []).length }));
        for (const note of m.notes ?? []) toast.message(note);
        await loadCatalog(selected);
      } else toast.error(d.error || t("installFailed"));
    } catch {
      toast.error(t("installFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!markets.length) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    );
  }

  const filtered = items.filter((c) => {
    const q = query.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      {markets.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {markets.map((m) => (
            <Button key={m.id} size="sm" variant={selected === m.id ? "default" : "outline"} onClick={() => setSelected(m.id)}>
              {m.name}
            </Button>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-8" />
      </div>

      {catalogLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <div key={c.name} className="flex items-center gap-3 rounded-xl border p-3">
              <PluginIcon name={c.name} homepage={c.homepage} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{c.name}</span>
                  {c.author && <span className="truncate text-xs text-muted-foreground">{t("by", { author: c.author })}</span>}
                </div>
                {c.description && <p className="truncate text-xs text-muted-foreground">{c.description}</p>}
              </div>
              {c.installed ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
                  <Check className="h-3.5 w-3.5" />{t("installedLabel")}
                </span>
              ) : (
                <Button size="sm" variant="outline" disabled={!c.installable || busy === c.name} onClick={() => install(c.name)}>
                  {busy === c.name ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
                  {t("install")}
                </Button>
              )}
            </div>
          ))}
          {filtered.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("noMatches", { query })}</p>}
        </div>
      )}
    </div>
  );
}
