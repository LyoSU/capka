"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  Loader2,
  Upload,
  Search,
  Trash2,
  ChevronDown,
  Sparkles,
  Store,
  UserRound,
  Users,
  Puzzle,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PluginIcon } from "@/components/plugin-icon";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/hooks/use-is-admin";

interface Skill {
  id: string;
  name: string;
  description: string | null;
  scope: "system" | "user" | "project";
  enabled: boolean;
  mine: boolean;
  plugin: { name: string; author: string | null; homepage: string | null } | null;
}

type SortKey = "name" | "status";
type GroupKind = "personal" | "plugin" | "team";
interface Group {
  key: string;
  kind: GroupKind;
  title: string;
  author: string | null;
  homepage: string | null;
  skills: Skill[];
}

export default function SkillLibrary({ chrome = true }: { chrome?: boolean }) {
  const t = useTranslations("settings.skills");
  const isAdmin = useIsAdmin();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingScope = useRef<"user" | "system">("user");

  const fetchSkills = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/skills");
      if (res.ok) setSkills((await res.json()).skills ?? []);
      else setError(t("loadError"));
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggle = async (s: Skill, enabled: boolean) => {
    const prev = skills;
    setSkills((list) => list.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
    // Own skill or a non-admin muting a shared one → /api/skills (personal).
    // An admin flipping a shared skill's global state → /api/admin/skills.
    const url = s.mine || !isAdmin ? "/api/skills" : "/api/admin/skills";
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.id, enabled }),
    });
    if (!res.ok) {
      setSkills(prev);
      toast.error(t("toggleFailed"));
    }
  };

  const remove = async (s: Skill) => {
    const prev = skills;
    setSkills((list) => list.filter((x) => x.id !== s.id));
    const url = s.mine ? `/api/skills?id=${encodeURIComponent(s.id)}` : `/api/admin/skills?id=${encodeURIComponent(s.id)}`;
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok) toast.success(t("deleted", { name: s.name }));
    else {
      setSkills(prev);
      toast.error(t("deleteFailed"));
    }
  };

  const startUpload = (scope: "user" | "system") => {
    pendingScope.current = scope;
    fileInputRef.current?.click();
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    const scope = pendingScope.current;
    try {
      const form = new FormData();
      form.append("file", file);
      const url = scope === "system" ? "/api/admin/skills" : "/api/skills";
      if (scope === "system") form.append("scope", "system");
      const res = await fetch(url, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(t("addSuccess", { name: data.name ?? "" }));
        await fetchSkills();
      } else {
        toast.error(data.error || t("addFailed"));
      }
    } catch {
      toast.error(t("addFailed"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ── Search + group + sort ──────────────────────────────────────────────────
  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.description?.toLowerCase().includes(q) ?? false) ||
            (s.plugin?.name.toLowerCase().includes(q) ?? false),
        )
      : skills;

    const personal: Skill[] = [];
    const team: Skill[] = [];
    const byPlugin = new Map<string, Group>();
    for (const s of filtered) {
      if (s.mine) personal.push(s);
      else if (s.plugin) {
        const key = `plugin:${s.plugin.name}`;
        const g = byPlugin.get(key) ?? {
          key,
          kind: "plugin" as const,
          title: s.plugin.name,
          author: s.plugin.author,
          homepage: s.plugin.homepage,
          skills: [],
        };
        g.skills.push(s);
        byPlugin.set(key, g);
      } else team.push(s);
    }

    const cmp = (a: Skill, b: Skill) =>
      sort === "status" && a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : a.name.localeCompare(b.name);

    const out: Group[] = [];
    if (personal.length)
      out.push({ key: "personal", kind: "personal", title: t("group.personal"), author: null, homepage: null, skills: personal.sort(cmp) });
    for (const g of [...byPlugin.values()].sort((a, b) => a.title.localeCompare(b.title))) {
      g.skills.sort(cmp);
      out.push(g);
    }
    if (team.length)
      out.push({ key: "team", kind: "team", title: t("group.team"), author: null, homepage: null, skills: team.sort(cmp) });
    return out;
  }, [skills, query, sort, t]);

  const total = skills.length;
  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="space-y-5">
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
        }}
      />

      {chrome && (
        <div>
          <h2 className="text-base font-medium">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      )}

      {/* Upload control */}
      <div className="flex justify-end">
        {isAdmin ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="sm" variant="outline" disabled={uploading}>
                  {uploading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
                  {t("add")}
                  <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => startUpload("user")}>
                <UserRound className="mr-2 h-4 w-4" /> {t("addPersonal")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startUpload("system")}>
                <Users className="mr-2 h-4 w-4" /> {t("addShared")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button size="sm" variant="outline" disabled={uploading} onClick={() => startUpload("user")}>
            {uploading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
            {t("addPersonal")}
          </Button>
        )}
      </div>

      {/* Toolbar */}
      {!loading && total > 0 && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="pl-8"
              aria-label={t("searchPlaceholder")}
            />
          </div>
          <Select
            value={sort}
            onValueChange={(v) => setSort(v as SortKey)}
            items={{ name: t("sort.name"), status: t("sort.status") }}
          >
            <SelectTrigger size="sm" className="w-[8.5rem]" aria-label={t("sortAria")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">{t("sort.name")}</SelectItem>
              <SelectItem value="status">{t("sort.status")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[4.25rem] animate-pulse rounded-lg border bg-muted/40" />
          ))}
        </div>
      )}

      {/* Empty state — teaches what skills are + where they come from */}
      {!loading && total === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="mx-auto max-w-xs text-sm text-muted-foreground">{t("emptyHint")}</p>
          </div>
          {isAdmin && (
            <Link href="/settings/skills?tab=marketplace" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              <Store className="mr-1.5 h-4 w-4" /> {t("browseMarketplace")}
            </Link>
          )}
        </div>
      )}

      {!loading && total > 0 && groups.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("noMatches", { query })}</p>
      )}

      {/* Grouped library */}
      <div className="space-y-5">
        {groups.map((g) => (
          <SkillGroup key={g.key} group={g} isAdmin={isAdmin} onToggle={toggle} onRemove={remove} t={t} />
        ))}
      </div>

      {!loading && total > 0 && (
        <p className="text-xs text-muted-foreground">{t("summary", { enabled: enabledCount, total })}</p>
      )}
    </div>
  );
}

function GroupAvatar({ group }: { group: Group }) {
  if (group.kind === "plugin") return <PluginIcon name={group.title} homepage={group.homepage} size={32} />;
  const Icon = group.kind === "personal" ? UserRound : Users;
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.55rem] bg-muted">
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  );
}

function SkillGroup({
  group,
  isAdmin,
  onToggle,
  onRemove,
  t,
}: {
  group: Group;
  isAdmin: boolean;
  onToggle: (s: Skill, enabled: boolean) => void;
  onRemove: (s: Skill) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Collapsible defaultOpen className="space-y-2">
      <CollapsibleTrigger
        render={
          <button className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent/40 [&[data-state=open]_.chevron]:rotate-180">
            <GroupAvatar group={group} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{group.title}</span>
                <span className="text-xs text-muted-foreground">{group.skills.length}</span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "ml-auto font-normal",
                    group.kind === "personal" ? "text-muted-foreground" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                  )}
                >
                  {group.kind === "personal" ? t("reach.personal") : t("reach.shared")}
                </Badge>
              </div>
              {group.kind === "plugin" && group.author && (
                <p className="truncate text-xs text-muted-foreground">{t("by", { author: group.author })}</p>
              )}
              {group.kind === "team" && <p className="text-xs text-muted-foreground">{t("group.teamHint")}</p>}
            </div>
            <ChevronDown className="chevron h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
          </button>
        }
      />
      <CollapsibleContent className="space-y-2 overflow-hidden">
        {group.skills.map((s) => (
          <SkillRow key={s.id} skill={s} canDelete={s.mine || isAdmin} onToggle={onToggle} onRemove={onRemove} t={t} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SkillRow({
  skill,
  canDelete,
  onToggle,
  onRemove,
  t,
}: {
  skill: Skill;
  canDelete: boolean;
  onToggle: (s: Skill, enabled: boolean) => void;
  onRemove: (s: Skill) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const noDescription = !skill.description?.trim();
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/15">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70">
        <Puzzle className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{skill.name}</span>
          {noDescription && (
            <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-500">
              <AlertTriangle className="h-3 w-3" /> {t("noDescription")}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {skill.description?.trim() || t("noDescriptionHint")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Switch
          checked={skill.enabled}
          onCheckedChange={(v) => onToggle(skill, v)}
          aria-label={t("toggleAria", { name: skill.name })}
        />
        {canDelete && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={t("deleteAria", { name: skill.name })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("deleteTitle", { name: skill.name })}</AlertDialogTitle>
                <AlertDialogDescription>
                  {skill.plugin ? t("deletePluginWarn", { plugin: skill.plugin.name }) : t("deleteWarn")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onRemove(skill)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t("delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
