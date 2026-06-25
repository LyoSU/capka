"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, ShieldCheck, Sparkles, Plug } from "lucide-react";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/hooks/use-is-admin";

type Effect = "allow" | "deny" | "ask";
type CapabilityType = "skill" | "connector";
interface Policy { id: string; capabilityType: CapabilityType; capabilityKey: string; effect: Effect; scope: string }
interface InvItem { capabilityType: CapabilityType; capabilityKey: string }
interface AuditEntry { id: string; action: string; targetKey: string | null; createdAt: string | null }

const KNOWN_ACTIONS = new Set([
  "plugin.install", "plugin.uninstall", "connector.add", "connector.remove",
  "connector.enable", "connector.disable", "policy.set", "policy.clear",
]);

/** Three-way segmented control: Allow / Ask / Deny. */
function EffectControl({ value, onChange, t }: { value: Effect; onChange: (e: Effect) => void; t: ReturnType<typeof useTranslations> }) {
  const opts: { e: Effect; soon?: boolean }[] = [{ e: "allow" }, { e: "ask", soon: true }, { e: "deny" }];
  const color: Record<Effect, string> = {
    allow: "bg-success/15 text-success",
    ask: "bg-warning-text/15 text-warning-text",
    deny: "bg-destructive/15 text-destructive",
  };
  return (
    <div className="flex overflow-hidden rounded-md border text-xs">
      {opts.map(({ e, soon }) => (
        <button
          key={e}
          onClick={() => onChange(e)}
          title={soon ? t("askSoon") : undefined}
          className={cn("px-2.5 py-1 transition-colors", value === e ? color[e] : "text-muted-foreground hover:bg-accent/50")}
        >
          {t(`effect.${e}`)}{soon && value === e ? " *" : ""}
        </button>
      ))}
    </div>
  );
}

export default function PermissionsPage() {
  const t = useTranslations("settings.permissions");
  const isAdmin = useIsAdmin();
  const [inventory, setInventory] = useState<InvItem[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([fetch("/api/admin/policies"), fetch("/api/admin/audit?limit=50")]);
      if (p.ok) { const d = await p.json(); setPolicies(d.policies ?? []); setInventory(d.inventory ?? []); }
      if (a.ok) setAudit((await a.json()).entries ?? []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (isAdmin) load(); else setLoading(false); }, [isAdmin, load]);

  // Effect + existing policy id for a capability (system scope; default allow).
  const policyFor = (type: CapabilityType, key: string) =>
    policies.find((p) => p.scope === "system" && p.capabilityType === type && p.capabilityKey === key);

  const change = async (type: CapabilityType, key: string, effect: Effect) => {
    const existing = policyFor(type, key);
    // Back to the default → clear the row; otherwise upsert.
    if (effect === "allow" && existing) {
      const res = await fetch(`/api/admin/policies?id=${encodeURIComponent(existing.id)}`, { method: "DELETE" });
      if (!res.ok) return toast.error(t("saveFailed"));
    } else if (effect !== "allow" || !existing) {
      const res = await fetch("/api/admin/policies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilityType: type, capabilityKey: key, effect }) });
      if (!res.ok) return toast.error(t("saveFailed"));
    }
    await load();
  };

  if (!isAdmin) return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;

  const skills = inventory.filter((i) => i.capabilityType === "skill");
  const connectors = inventory.filter((i) => i.capabilityType === "connector");

  const section = (title: string, Icon: typeof Sparkles, items: InvItem[]) =>
    items.length > 0 && (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium"><Icon className="h-4 w-4 text-muted-foreground" />{title}</div>
        {items.map((i) => {
          const effect = policyFor(i.capabilityType, i.capabilityKey)?.effect ?? "allow";
          return (
            <div key={`${i.capabilityType}:${i.capabilityKey}`} className={cn("flex items-center justify-between gap-4 rounded-md border p-2.5", effect === "deny" && "opacity-60")}>
              <span className="truncate text-sm">{i.capabilityKey}</span>
              <EffectControl value={effect} onChange={(e) => change(i.capabilityType, i.capabilityKey, e)} t={t} />
            </div>
          );
        })}
      </div>
    );

  const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString() : "");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      {loading && <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}

      {!loading && inventory.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <ShieldCheck className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      )}

      {!loading && inventory.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
          {section(t("skills"), Sparkles, skills)}
          {section(t("connectors"), Plug, connectors)}
        </>
      )}

      {!loading && audit.length > 0 && (
        <div className="space-y-2 pt-2">
          <h3 className="text-sm font-medium">{t("activity")}</h3>
          <div className="rounded-md border divide-y">
            {audit.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span>
                  {KNOWN_ACTIONS.has(e.action) ? t(`actions.${e.action}` as never) : e.action}
                  {e.targetKey && <span className="text-muted-foreground"> · {e.targetKey}</span>}
                </span>
                <span className="shrink-0 text-muted-foreground">{fmtTime(e.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
