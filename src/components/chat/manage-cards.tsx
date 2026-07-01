import { useTranslations } from "next-intl";
import { Check, Undo2, AlertTriangle, SlidersHorizontal, ExternalLink, Stethoscope, Plug, Trash2, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";

type RequiredAction = { kind: string; url: string; label: string; description?: string };

/** The subset of a `manage` tool result the chat renders as a card. Kept loose
 *  (all optional) because it arrives as opaque tool output. */
type ManageOutput = {
  render?: string;
  summary?: string;
  confirmToken?: string;
  preview?: { title: string; before: string; after: string; impact?: string };
  action?: RequiredAction;
  data?: {
    title?: string;
    before?: string;
    after?: string;
    undoToken?: string;
    // collection
    collectionId?: string;
    items?: { id: string; title: string; subtitle?: string; enabled?: boolean; status?: string; owned?: boolean }[];
    // resource
    op?: "added" | "removed" | "enabled" | "disabled";
    itemTitle?: string;
    action?: RequiredAction;
    // debug
    state?: string;
    detail?: string;
    hint?: string;
  };
};

const CARD_RENDERS = new Set(["confirm", "setting", "action_required", "resource", "debug", "collection"]);

/** A `manage` result becomes a prominent card (not a quiet rail step) when it's
 *  something the user must SEE or ACT on. Plain reads (`value`, `list`) stay in
 *  the activity rail. */
export function isManageCard(output: unknown): boolean {
  const r = (output as ManageOutput | null)?.render;
  return r ? CARD_RENDERS.has(r) : false;
}

/** OAuth / open-url handoff — the agent can't click, so the user does. Rendered
 *  as a link-button (a real navigation, not an onSend). */
function ConnectLink({ action }: { action: RequiredAction }) {
  return (
    <a
      href={action.url}
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      <Plug className="h-3.5 w-3.5" />
      {action.label}
    </a>
  );
}

const OP_ICON = { added: Plug, removed: Trash2, enabled: Power, disabled: Power } as const;

/** before → after, with the old value dimmed/struck and the new value emphasised.
 *  When there's no meaningful "before" (e.g. an empty default) only the new value
 *  shows, so a first-time set doesn't read as "nothing → x". */
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      {before && before !== after && (
        <>
          <span className="text-muted-foreground line-through decoration-muted-foreground/50">{before}</span>
          <span aria-hidden className="text-muted-foreground">→</span>
        </>
      )}
      <span className="font-medium text-foreground">{after}</span>
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return <div className="animate-blur-rise my-3 rounded-xl border border-border bg-card p-4 shadow-sm">{children}</div>;
}

export function ManageCard({ output, onSend }: { output: unknown; onSend?: (text: string) => void }) {
  const t = useTranslations("chat.manage");
  const o = output as ManageOutput;

  if (o?.render === "confirm" && o.preview) {
    const { title, before, after, impact } = o.preview;
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          {t("confirmTitle")}
        </div>
        <div className="mt-2 text-sm text-muted-foreground">{title}</div>
        <Diff before={before} after={after} />
        {impact && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{impact}</span>
          </div>
        )}
        {onSend && (
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                haptic("success");
                onSend(t("applyMsg", { title, after }));
              }}
            >
              {t("apply")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSend(t("cancelMsg", { title }))}>
              {t("cancel")}
            </Button>
          </div>
        )}
      </CardShell>
    );
  }

  if (o?.render === "setting" && o.data) {
    const { title = "", before = "", after = "", undoToken } = o.data;
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
          {t("settingTitle")}
        </div>
        <div className="mt-2 text-sm text-muted-foreground">{title}</div>
        <Diff before={before} after={after} />
        {onSend && undoToken && (
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={() => onSend(t("undoMsg", { title }))}>
              <Undo2 className="h-3.5 w-3.5" />
              {t("undo")}
            </Button>
          </div>
        )}
      </CardShell>
    );
  }

  // OAuth / browser hand-off — the agent returned a URL only the user can open.
  if (o?.render === "action_required" && o.action) {
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ExternalLink className="h-4 w-4 text-muted-foreground" />
          {o.action.description ?? t("openHint")}
        </div>
        <div className="mt-3">
          <ConnectLink action={o.action} />
        </div>
      </CardShell>
    );
  }

  // A connector was added/removed/enabled/disabled — with an optional follow-up
  // (e.g. "now sign in" after adding an OAuth connector).
  if (o?.render === "resource" && o.data) {
    const Icon = OP_ICON[o.data.op ?? "added"] ?? Check;
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {o.summary}
        </div>
        {o.data.action && (
          <div className="mt-3">
            <ConnectLink action={o.data.action} />
          </div>
        )}
      </CardShell>
    );
  }

  if (o?.render === "debug" && o.data) {
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          {t("debugTitle")}: {o.data.itemTitle}
        </div>
        <div className="mt-2 text-sm">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{o.data.state}</span>
        </div>
        {o.data.detail && <div className="mt-2 text-sm text-muted-foreground">{o.data.detail}</div>}
        {o.data.hint && <div className="mt-1 text-sm text-muted-foreground">{o.data.hint}</div>}
        {o.data.action && (
          <div className="mt-3">
            <ConnectLink action={o.data.action} />
          </div>
        )}
      </CardShell>
    );
  }

  if (o?.render === "collection" && o.data?.items) {
    const items = o.data.items;
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Plug className="h-4 w-4 text-muted-foreground" />
          {o.data.title ?? t("connectorsTitle")}
        </div>
        {items.length === 0 ? (
          <div className="mt-2 text-sm text-muted-foreground">—</div>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {items.map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{it.title}</span>
                  {it.subtitle && <span className="ml-2 truncate text-xs text-muted-foreground">{it.subtitle}</span>}
                </span>
                <span className={`shrink-0 text-xs ${it.enabled === false ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
                  {it.enabled === false ? "off" : it.status ?? "on"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardShell>
    );
  }

  return null;
}
