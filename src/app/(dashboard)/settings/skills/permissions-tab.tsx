"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { ShieldCheck, Sparkles, Plug, X, ChevronRight, Search } from "lucide-react";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { SettingsEmpty, SettingsSkeleton, ShowMore, useShowMore } from "@/components/settings/shell";
import { authClient } from "@/lib/auth-client";
import { explainPolicy } from "@/lib/governance/matcher";
import type { PolicyScope } from "@/lib/governance/types";
import { EffectBadge } from "@/components/shared/effect-badge";

type Effect = "allow" | "deny" | "ask";
type CapabilityType = "skill" | "connector";
interface Policy {
  id: string; scope: PolicyScope; capabilityType: CapabilityType; capabilityKey: string; effect: Effect;
  userId: string | null; projectId: string | null;
  userName: string | null; userEmail: string | null; projectName: string | null;
}
interface InvItem { capabilityType: CapabilityType; capabilityKey: string; description?: string | null }
interface Member { id: string; name: string | null; email: string | null }
interface RawProject { id: string; name: string; ownerId: string; ownerName: string | null }
interface Project extends RawProject { label: string }
interface AuditEntry { id: string; action: string; targetType: string | null; targetKey: string | null; detail: Record<string, unknown>; actorName: string | null; actorEmail: string | null; createdAt: string | null }

type T = ReturnType<typeof useTranslations>;

/** Three-way segmented control: Allow / Block until approved / Deny. The stored
 *  "ask" value is unchanged; only its label is honest about being a block today. */
function EffectControl({ value, onChange, t, size = "default" }: { value: Effect; onChange: (e: Effect) => void; t: T; size?: "sm" | "default" }) {
  const opts: Effect[] = ["allow", "ask", "deny"];
  const color: Record<Effect, string> = {
    allow: "bg-success/15 text-success",
    ask: "bg-warning-text/15 text-warning-text",
    deny: "bg-destructive/15 text-destructive",
  };
  return (
    <div className="flex overflow-hidden rounded-md border text-xs">
      {opts.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onChange(e)}
          aria-pressed={value === e}
          className={cn(size === "sm" ? "px-2 py-0.5" : "px-2.5 py-1", "transition-colors", value === e ? color[e] : "text-muted-foreground hover:bg-hover")}
        >
          {t(`effect.${e}`)}
        </button>
      ))}
    </div>
  );
}

export function PermissionsTab() {
  const t = useTranslations("settings.permissions");
  const isAdmin = useIsAdmin();
  const [inventory, setInventory] = useState<InvItem[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<RawProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<InvItem | null>(null);
  const { data: session } = authClient.useSession();
  const meId = session?.user?.id;

  // Label a project with its owner only when that adds signal: the name repeats
  // across owners, or the project isn't the admin's own.
  const labeledProjects: Project[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    return projects.map((p) => {
      const showOwner = p.ownerName && ((counts.get(p.name) ?? 0) > 1 || p.ownerId !== meId);
      return { ...p, label: showOwner ? `${p.name} (${p.ownerName})` : p.name };
    });
  }, [projects, meId]);

  const load = useCallback(async () => {
    try {
      const [p, u] = await Promise.all([
        fetch("/api/admin/policies"),
        fetch("/api/admin/users"),
      ]);
      // Projects come from the policies route (org-wide, admin-scoped) — NOT
      // /api/projects, which is scoped to the requester's own projects.
      if (p.ok) { const d = await p.json(); setPolicies(d.policies ?? []); setInventory(d.inventory ?? []); setProjects(d.projects ?? []); }
      // The users route may serve a bare array today or `{ users, tiers }` after a
      // parallel change — accept either shape.
      if (u.ok) { const d = await u.json(); setMembers(Array.isArray(d) ? d : d.users ?? []); }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (isAdmin) load(); else setLoading(false); }, [isAdmin, load]);

  const systemPolicy = (i: InvItem) => policies.find((p) => p.scope === "system" && p.capabilityType === i.capabilityType && p.capabilityKey === i.capabilityKey);
  const globalEffect = (i: InvItem): Effect => systemPolicy(i)?.effect ?? "allow";
  const exceptionsFor = (i: InvItem) => policies.filter((p) => p.scope !== "system" && p.capabilityType === i.capabilityType && p.capabilityKey === i.capabilityKey);

  // Global rule: back to the default clears the row, otherwise upsert a system policy.
  const setGlobal = async (i: InvItem, effect: Effect) => {
    const existing = systemPolicy(i);
    // Re-clicking the already-default Allow must stay a no-op: the default is the
    // ABSENCE of a row, so materializing an explicit allow would only add policy
    // and audit noise with no behavior change.
    if (effect === "allow" && !existing) return;
    if (effect === "allow" && existing) {
      const res = await fetch(`/api/admin/policies?id=${encodeURIComponent(existing.id)}`, { method: "DELETE" });
      if (!res.ok) return toast.error(t("saveFailed"));
    } else if (effect !== "allow") {
      const res = await fetch("/api/admin/policies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilityType: i.capabilityType, capabilityKey: i.capabilityKey, effect, scope: "system" }) });
      if (!res.ok) return toast.error(t("saveFailed"));
    }
    await load();
  };

  const addException = async (i: InvItem, scope: "user" | "project", subjectId: string, effect: Effect) => {
    const body = { capabilityType: i.capabilityType, capabilityKey: i.capabilityKey, effect, scope, ...(scope === "user" ? { userId: subjectId } : { projectId: subjectId }) };
    const res = await fetch("/api/admin/policies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return toast.error(t("saveFailed"));
    await load();
  };

  const removeException = async (id: string) => {
    const res = await fetch(`/api/admin/policies?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) return toast.error(t("saveFailed"));
    await load();
  };

  if (!isAdmin) return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;

  // What this page is actually about: the capabilities somebody has ruled on.
  // Everything else is the default, and listing 140 identical "allowed" rows
  // above the four that were decided buries the page's own content.
  const configured = inventory.filter((i) => systemPolicy(i) || exceptionsFor(i).length > 0);
  const defaults = inventory.filter((i) => !systemPolicy(i) && exceptionsFor(i).length === 0);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      {loading && <SettingsSkeleton rows={4} header={false} />}

      {!loading && inventory.length === 0 && (
        <SettingsEmpty icon={ShieldCheck} title={t("empty")} hint={t("emptyHint")} />
      )}

      {!loading && inventory.length > 0 && (
        <>
          <div className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{t("bannerTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("bannerBody")}</p>
            </div>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("configuredTitle")}</h3>
            {configured.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("configuredEmpty")}</p>
            ) : (
              <div className="space-y-1.5">
                {configured.map((i) => (
                  <CapabilityRow
                    key={`${i.capabilityType}:${i.capabilityKey}`}
                    item={i} t={t} onOpen={() => setOpen(i)}
                    effect={globalEffect(i)}
                    exceptionCount={exceptionsFor(i).length}
                  />
                ))}
              </div>
            )}
          </section>

          <DefaultsSection items={defaults} t={t} onOpen={setOpen} />
        </>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 p-0 sm:max-w-2xl">
          {open && (
            <CapabilityDrawer
              key={`${open.capabilityType}:${open.capabilityKey}`}
              item={open} t={t}
              globalEffect={globalEffect(open)}
              exceptions={exceptionsFor(open)}
              members={members}
              projects={labeledProjects}
              policiesForCap={policies.filter((p) => p.capabilityType === open.capabilityType && p.capabilityKey === open.capabilityKey)}
              onSetGlobal={(e) => setGlobal(open, e)}
              onAddException={(scope, subjectId, e) => addException(open, scope, subjectId, e)}
              onRemoveException={removeException}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One capability in a list.
 *
 * A row that is simply on the default carries NO badge: the green "Allow" chip
 * sat where every table puts its action and read as a call to press it, and
 * repeating it down a hundred untouched rows drowned the four that were actually
 * decided. Colour is spent only where something was ruled.
 */
function CapabilityRow({
  item, t, onOpen, effect, exceptionCount,
}: {
  item: InvItem; t: T; onOpen: () => void; effect: Effect; exceptionCount: number;
}) {
  const Icon = item.capabilityType === "skill" ? Sparkles : Plug;
  const ruled = effect !== "allow" || exceptionCount > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md border p-2.5 text-left transition-colors hover:bg-hover"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={t(item.capabilityType === "skill" ? "skills" : "connectors")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.capabilityKey}</span>
        {item.description && (
          <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
        )}
      </span>
      {exceptionCount > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">{t("exceptions", { count: exceptionCount })}</span>
      )}
      {ruled ? (
        <EffectBadge effect={effect} label={t(`effect.${effect}`)} />
      ) : (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden />
      )}
    </button>
  );
}

/** Everything nobody has ruled on: collapsed by default, searchable, and paged.
 *  It is reference material — the inventory you go looking through to restrict
 *  something — not a list to read top to bottom. */
function DefaultsSection({ items, t, onOpen }: { items: InvItem[]; t: T; onOpen: (i: InvItem) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = items.filter((i) =>
    !q || i.capabilityKey.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q));
  const skillItems = matches.filter((i) => i.capabilityType === "skill");
  const connectorItems = matches.filter((i) => i.capabilityType === "connector");

  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left text-sm font-medium"
      >
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        {t("defaultsTitle", { count: items.length })}
      </button>

      {expanded && (
        <div className="space-y-4 pt-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchCapability")} className="h-9 pl-8" />
          </div>
          {matches.length === 0 && <p className="text-sm text-muted-foreground">{t("noMatches")}</p>}
          <DefaultsGroup title={t("skills")} items={skillItems} t={t} onOpen={onOpen} />
          <DefaultsGroup title={t("connectors")} items={connectorItems} t={t} onOpen={onOpen} />
        </div>
      )}
    </section>
  );
}

/** Skills and connectors are different kinds of thing to restrict, and mixed
 *  into one alphabetical run they read as an undifferentiated wall. Each group
 *  pages on its own, so opening one doesn't push the other out of reach. */
function DefaultsGroup({ title, items, t, onOpen }: { title: string; items: InvItem[]; t: T; onOpen: (i: InvItem) => void }) {
  const page = useShowMore(items, `${items.length}`);
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title} · {items.length}</p>
      {page.visible.map((i) => (
        <CapabilityRow
          key={`${i.capabilityType}:${i.capabilityKey}`}
          item={i} t={t} onOpen={() => onOpen(i)} effect="allow" exceptionCount={0}
        />
      ))}
      <ShowMore shown={page.visible.length} total={page.total} onMore={page.more} />
    </div>
  );
}

function CapabilityDrawer({
  item, t, globalEffect, exceptions, members, projects, policiesForCap,
  onSetGlobal, onAddException, onRemoveException,
}: {
  item: InvItem; t: T; globalEffect: Effect; exceptions: Policy[];
  members: Member[]; projects: Project[]; policiesForCap: Policy[];
  onSetGlobal: (e: Effect) => void;
  onAddException: (scope: "user" | "project", subjectId: string, effect: Effect) => void;
  onRemoveException: (id: string) => void;
}) {
  const memberLabel = (m: Member) => m.name || m.email || m.id;
  // THIS capability's history, filtered in SQL — a recent-events window fished
  // client-side goes blank once busier subjects push past it.
  const [history, setHistory] = useState<AuditEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ targetType: item.capabilityType, targetKey: item.capabilityKey, limit: "50" });
    fetch(`/api/admin/audit?${q}`)
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((d) => { if (!cancelled) setHistory((d.entries ?? []).filter((a: AuditEntry) => a.action.startsWith("policy."))); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item.capabilityType, item.capabilityKey]);

  const userExceptions = exceptions.filter((e) => e.scope === "user");
  const projectExceptions = exceptions.filter((e) => e.scope === "project");
  // Members / projects that don't already have an exception for this capability.
  const availableMembers = members.filter((m) => !userExceptions.some((e) => e.userId === m.id));
  const availableProjects = projects.filter((p) => !projectExceptions.some((e) => e.projectId === p.id));

  return (
    <>
      {/* Header pinned, body scrolled — same split as the person card, so the
          capability's name and the close button stay reachable down a long
          exception list. */}
      <DialogHeader className="gap-1 border-b px-4 py-3 pr-12">
        <DialogTitle className="truncate">{item.capabilityKey}</DialogTitle>
        <DialogDescription>{t(item.capabilityType === "skill" ? "typeSkill" : "typeConnector")}</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable]">
        {/* Global rule */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("globalRule")}</h3>
          <p className="text-xs text-muted-foreground">{t("globalRuleHint")}</p>
          <EffectControl value={globalEffect} onChange={onSetGlobal} t={t} />
        </section>

        <Separator />

        {/* Per-person exceptions */}
        <ExceptionSection
          title={t("userExceptions")} scope="user" t={t}
          rows={userExceptions.map((e) => ({ id: e.id, label: e.userName || e.userEmail || e.userId || "", effect: e.effect }))}
          pickerItems={availableMembers.map((m) => ({ id: m.id, label: memberLabel(m) }))}
          onAdd={(id, e) => onAddException("user", id, e)} onRemove={onRemoveException}
        />

        {/* Per-project exceptions */}
        <ExceptionSection
          title={t("projectExceptions")} scope="project" t={t}
          rows={projectExceptions.map((e) => ({ id: e.id, label: e.projectName || e.projectId || "", effect: e.effect }))}
          pickerItems={availableProjects.map((p) => ({ id: p.id, label: p.label }))}
          onAdd={(id, e) => onAddException("project", id, e)} onRemove={onRemoveException}
        />

        <Separator />

        {/* Check access */}
        <CheckAccess item={item} t={t} members={members} projects={projects} policiesForCap={policiesForCap} memberLabel={memberLabel} />

        <Separator />

        {/* Change history */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("history")}</h3>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noHistory")}</p>
          ) : (
            <ul className="space-y-1.5">
              {history.map((h) => (
                <li key={h.id} className="text-xs text-muted-foreground">
                  <span className="text-foreground">{t(h.action === "policy.set" ? "histSet" : "histClear", { effect: t(`effect.${(h.detail.effect as Effect) ?? "allow"}`), scope: t(`scope.${(h.detail.scope as PolicyScope) ?? "system"}`) })}</span>
                  {h.createdAt && <span className="ml-1">· {new Date(h.createdAt).toLocaleDateString()}</span>}
                  {(h.actorName || h.actorEmail) && <span className="ml-1">· {h.actorName || h.actorEmail}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function ExceptionSection({
  title, scope, t, rows, pickerItems, onAdd, onRemove,
}: {
  title: string; scope: "user" | "project"; t: T;
  rows: { id: string; label: string; effect: Effect }[];
  pickerItems: { id: string; label: string }[];
  onAdd: (subjectId: string, effect: Effect) => void;
  onRemove: (id: string) => void;
}) {
  const [subject, setSubject] = useState<string | null>(null);
  const [effect, setEffect] = useState<Effect>("deny");
  const items = useMemo(() => Object.fromEntries(pickerItems.map((p) => [p.id, p.label])), [pickerItems]);

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">{t("noExceptions")}</p>}
      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-md border p-2">
              <span className="min-w-0 flex-1 truncate text-sm">{r.label}</span>
              <EffectBadge effect={r.effect} label={t(`effect.${r.effect}`)} />
              {/* Dropping an exception widens or narrows who may use the capability,
                  so the X asks first instead of taking effect on the click. */}
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label={t("removeException")}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("removeExceptionTitle", { name: r.label })}</AlertDialogTitle>
                    <AlertDialogDescription>{t("removeExceptionWarn")}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onRemove(r.id)}>{t("removeException")}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}
      {pickerItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Select value={subject} onValueChange={(v) => setSubject(v as string)} items={items}>
            <SelectTrigger size="sm" className="min-w-40 flex-1">
              <SelectValue placeholder={t(scope === "user" ? "pickMember" : "pickProject")} />
            </SelectTrigger>
            <SelectContent>
              {pickerItems.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <EffectControl value={effect} onChange={setEffect} t={t} size="sm" />
          <Button
            variant="outline" size="sm"
            disabled={!subject}
            onClick={() => { if (subject) { onAdd(subject, effect); setSubject(null); setEffect("deny"); } }}
          >
            {t("add")}
          </Button>
        </div>
      )}
    </section>
  );
}

function CheckAccess({
  item, t, members, projects, policiesForCap, memberLabel,
}: {
  item: InvItem; t: T; members: Member[]; projects: Project[];
  policiesForCap: Policy[]; memberLabel: (m: Member) => string;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const memberItems = useMemo(() => Object.fromEntries(members.map((m) => [m.id, memberLabel(m)])), [members, memberLabel]);
  // Only the selected person's own projects: a runtime check pairs a user with a
  // project they can actually work in, so offering someone else's project would
  // "explain" an access state that can never occur.
  const userProjects = useMemo(() => projects.filter((p) => p.ownerId === userId), [projects, userId]);
  const projectItems = useMemo(() => Object.fromEntries(userProjects.map((p) => [p.id, p.label])), [userProjects]);

  const result = useMemo(() => {
    if (!userId) return undefined;
    const rows = policiesForCap
      .filter((p) => p.scope === "system" || (p.scope === "user" && p.userId === userId) || (p.scope === "project" && projectId && p.projectId === projectId))
      .map((p) => ({ id: p.id, scope: p.scope, capabilityType: p.capabilityType, capabilityKey: p.capabilityKey, effect: p.effect }));
    return explainPolicy(rows, item.capabilityType, item.capabilityKey);
  }, [userId, projectId, policiesForCap, item]);

  const explanation = () => {
    if (result === undefined) return null;
    if (result === null) return t("checkDefault");
    const verb = t(`verb.${result.effect}`);
    const won = policiesForCap.find((p) => p.id === result.policyId);
    if (result.scope === "system") return t("checkBySystem", { verb });
    if (result.scope === "user") return t("checkByUser", { verb, name: won?.userName || won?.userEmail || "" });
    return t("checkByProject", { verb, name: won?.projectName || "" });
  };

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t("checkAccess")}</h3>
      <p className="text-xs text-muted-foreground">{t("checkAccessHint")}</p>
      <div className="flex flex-wrap gap-2">
        <Select value={userId} onValueChange={(v) => { setUserId(v as string); setProjectId(null); }} items={memberItems}>
          <SelectTrigger size="sm" className="min-w-40 flex-1">
            <SelectValue placeholder={t("pickMember")} />
          </SelectTrigger>
          <SelectContent>
            {members.map((m) => (<SelectItem key={m.id} value={m.id}>{memberLabel(m)}</SelectItem>))}
          </SelectContent>
        </Select>
        {userId && userProjects.length > 0 && (
          <Select value={projectId} onValueChange={(v) => setProjectId(v as string)} items={projectItems}>
            <SelectTrigger size="sm" className="min-w-40 flex-1">
              <SelectValue placeholder={t("pickProjectOptional")} />
            </SelectTrigger>
            <SelectContent>
              {userProjects.map((p) => (<SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>))}
            </SelectContent>
          </Select>
        )}
      </div>
      {userId && (
        <div className="rounded-md border bg-muted/30 p-2.5 text-sm">
          {explanation()}
        </div>
      )}
    </section>
  );
}
