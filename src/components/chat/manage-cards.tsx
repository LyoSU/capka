import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Check, Undo2, AlertTriangle, SlidersHorizontal, ExternalLink, Stethoscope, Plug, Trash2, Power, Loader2, RefreshCw, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";

type RequiredAction = { kind: string; url: string; label: string; description?: string };

/** The subset of a `manage` tool result the chat renders as a card. Kept loose
 *  (all optional) because it arrives as opaque tool output. */
type ManageOutput = {
  status?: string;
  render?: string;
  summary?: string;
  code?: string;
  /** Opaque handle to a server-staged change (confirm). Applying it needs the
   *  session/callback — the model never holds anything replayable. */
  pendingId?: string;
  preview?: { title: string; before: string; after: string; impact?: string; details?: string; body?: string };
  action?: RequiredAction;
  data?: {
    title?: string;
    controlId?: string;
    before?: string;
    after?: string;
    // choice (enum chip picker)
    value?: string;
    options?: { value: string; label: string }[];
    undoPendingId?: string;
    /** Refresh the route after apply/undo (e.g. a locale change takes effect now). */
    reload?: boolean;
    // collection
    collectionId?: string;
    items?: { id: string; title: string; subtitle?: string; enabled?: boolean; status?: string; owned?: boolean }[];
    /** The full settings page that manages this collection (quiet "Open in settings" link). */
    settingsPath?: string;
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

const CARD_RENDERS = new Set(["confirm", "setting", "choice", "action_required", "resource", "debug", "collection"]);

/** A `manage` result becomes a prominent card (not a quiet rail step) when it's
 *  something the user must SEE or ACT on. Plain reads (`value`, `list`) stay in
 *  the activity rail. */
export function isManageCard(output: unknown): boolean {
  const r = (output as ManageOutput | null)?.render;
  return r ? CARD_RENDERS.has(r) : false;
}

/** Consume a staged pending id via the session-authed endpoint — the ONLY path a
 *  confirm-gated change (or an undo) applies. Returns the resulting manage result. */
async function consumePending(pendingId: string): Promise<ManageOutput> {
  const res = await fetch("/api/manage/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pendingId }),
  });
  return (await res.json()) as ManageOutput;
}

/** OAuth / open-url handoff — the agent can't click, so the user does. For an
 *  OAuth sign-in we open a POPUP and wait for the callback page to postMessage
 *  back (see the oauth callback route) — then close it and re-check, so the user
 *  never leaves the chat. If the popup is blocked we fall back to a full-page
 *  navigation (the callback redirects instead). `open_url` stays a plain link. */
function ConnectLink({ action, onConnected }: { action: RequiredAction; onConnected?: () => void }) {
  const onClick = (e: React.MouseEvent) => {
    if (action.kind !== "oauth") return; // open_url: let the anchor navigate normally
    e.preventDefault();
    const popup = window.open(action.url, "capka-oauth", "popup,width=520,height=680");
    if (!popup) { window.location.href = action.url; return; } // blocked → full navigation
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      if ((ev.data as { type?: string } | null)?.type !== "capka:oauth") return;
      window.removeEventListener("message", onMsg);
      try { popup.close(); } catch { /* already closed */ }
      onConnected?.();
    };
    window.addEventListener("message", onMsg);
  };
  return (
    <a
      href={action.url}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      <Plug className="h-3.5 w-3.5" />
      {action.label}
    </a>
  );
}

const OP_ICON = { added: Plug, removed: Trash2, enabled: Power, disabled: Power } as const;

/** Quiet client-side link from a chat card to the full settings page that manages
 *  the same thing — the card is a summary; the page is the richer UI (#12). */
function SettingsLink({ href, t }: { href: string; t: T }) {
  return (
    <Link
      href={href}
      className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {t("openInSettings")}
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  );
}

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

type T = ReturnType<typeof useTranslations>;

/** A terminal one-line footer (applied / reverted / expired / cancelled / error)
 *  the confirm & setting cards collapse to after the user acts. */
function Outcome({ kind, text }: { kind: "done" | "expired" | "cancelled" | "error"; text: string }) {
  const tone =
    kind === "done" ? "text-emerald-600 dark:text-emerald-500"
    : kind === "error" ? "text-destructive"
    : "text-muted-foreground";
  const Icon = kind === "done" ? Check : kind === "error" ? AlertTriangle : Undo2;
  return (
    <div className={`mt-3 flex items-center gap-1.5 text-sm ${tone}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

/** Staged change awaiting the USER's confirmation. Confirm/Cancel act via the
 *  session-authed endpoint (never the model), then the card collapses to its
 *  outcome — so a button can't be clicked twice and a stale card reads clearly. */
function ConfirmCard({ o, t, onSend }: { o: ManageOutput; t: T; onSend?: (text: string) => void }) {
  const { title, before, after, impact, details, body } = o.preview!;
  // Start "checking": on mount we ask the server whether this pending is still
  // open, so a RELOADED card shows "confirmed"/"expired" instead of live buttons
  // for a change that already happened (React state doesn't survive a reload).
  const [phase, setPhase] = useState<"checking" | "idle" | "applying" | "done" | "expired" | "cancelled" | "error">(
    o.pendingId ? "checking" : "idle",
  );
  const [errText, setErrText] = useState("");
  // A follow-up the apply result carries (e.g. an OAuth sign-in for a just-added
  // connector) — surfaced right in this card so the user doesn't have to ask again.
  const [followUp, setFollowUp] = useState<RequiredAction | null>(null);

  useEffect(() => {
    if (!o.pendingId) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/manage/confirm?pendingId=${encodeURIComponent(o.pendingId!)}`);
        const { status } = (await res.json()) as { status: "open" | "applied" | "expired" | "gone" };
        if (!alive) return;
        // "gone" = the user cancelled it (or it was cleaned up) — show "cancelled",
        // not "expired", so a declined change reads correctly after a reload.
        setPhase(status === "open" ? "idle" : status === "applied" ? "done" : status === "gone" ? "cancelled" : "expired");
      } catch {
        if (alive) setPhase("idle"); // fall back to buttons; a click will resolve it
      }
    })();
    return () => { alive = false; };
  }, [o.pendingId]);

  const confirm = async () => {
    if (!o.pendingId || phase !== "idle") return;
    setPhase("applying");
    haptic("success");
    try {
      const r = await consumePending(o.pendingId);
      if (r.status === "ok") { setFollowUp(r.data?.action ?? r.action ?? null); setPhase("done"); }
      else if (r.code === "confirm_expired") setPhase("expired");
      else { setErrText(r.summary || t("applyError")); setPhase("error"); }
    } catch {
      setErrText(t("applyError"));
      setPhase("error");
    }
  };

  // Cancel must DROP the staged pending on the server, not just hide the buttons —
  // otherwise a reload re-offers Confirm for a change the user already declined.
  const cancel = async () => {
    if (!o.pendingId || phase !== "idle") return;
    setPhase("cancelled");
    haptic("tap");
    await fetch(`/api/manage/confirm?pendingId=${encodeURIComponent(o.pendingId)}`, { method: "DELETE" }).catch(() => {});
  };

  return (
    <CardShell>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        {t("confirmTitle")}
      </div>
      <div className="mt-2 text-sm text-muted-foreground">{title}</div>
      <Diff before={before} after={after} />
      {/* What the user is actually approving — description + the full text (e.g. a
          SKILL.md), collapsed — so a permanent instruction is never confirmed blind. */}
      {details && <div className="mt-2 text-sm text-muted-foreground">{details}</div>}
      {body && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t("viewInstructions")}</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 text-xs text-muted-foreground">{body}</pre>
        </details>
      )}
      {impact && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{impact}</span>
        </div>
      )}
      {phase === "idle" && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={confirm}>{t("apply")}</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>{t("cancel")}</Button>
        </div>
      )}
      {phase === "applying" && (
        <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />{t("applying")}
        </div>
      )}
      {phase === "done" && (
        <>
          <Outcome kind="done" text={t("confirmed")} />
          {/* e.g. "Connect" after adding an OAuth connector — sign in without leaving chat. */}
          {followUp && (
            <div className="mt-3">
              <ConnectLink action={followUp} onConnected={onSend ? () => onSend(t("signedIn")) : undefined} />
            </div>
          )}
        </>
      )}
      {phase === "expired" && <Outcome kind="expired" text={t("expired")} />}
      {phase === "cancelled" && <Outcome kind="cancelled" text={t("cancelled")} />}
      {phase === "error" && <Outcome kind="error" text={errText} />}
    </CardShell>
  );
}

/** An applied setting (before → after) with an Undo that also travels the
 *  human-authed endpoint (the model can't trigger an undo either). */
function SettingCard({ o, t }: { o: ManageOutput; t: T }) {
  const { title = "", controlId = "", before = "", after = "", undoPendingId, reload } = o.data!;
  const [phase, setPhase] = useState<"idle" | "applying" | "done" | "error">("idle");
  const router = useRouter();

  // A reloadOnApply change (locale) already applied server-side before this card
  // rendered, but the page was sent in the OLD language — refresh once so the UI
  // catches up. Guarded by a per-transition sessionStorage marker so it can't loop
  // (the refresh remounts this card) and doesn't re-fire for a historical card.
  useEffect(() => {
    if (!reload) return;
    const key = `capka:reloaded:${controlId}:${after}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    router.refresh();
  }, [reload, controlId, after, router]);

  const undo = async () => {
    if (!undoPendingId || phase !== "idle") return;
    setPhase("applying");
    haptic("tap");
    try {
      const r = await consumePending(undoPendingId);
      if (r.status === "ok") {
        setPhase("done");
        if (reload) router.refresh(); // revert the language too, immediately
      } else setPhase("error");
    } catch {
      setPhase("error");
    }
  };

  return (
    <CardShell>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
        {t("settingTitle")}
      </div>
      <div className="mt-2 text-sm text-muted-foreground">{title}</div>
      <Diff before={before} after={after} />
      {undoPendingId && phase === "idle" && (
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={undo}>
            <Undo2 className="h-3.5 w-3.5" />
            {t("undo")}
          </Button>
        </div>
      )}
      {phase === "applying" && (
        <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />{t("applying")}
        </div>
      )}
      {phase === "done" && <Outcome kind="done" text={t("reverted")} />}
      {phase === "error" && <Outcome kind="error" text={t("applyError")} />}
    </CardShell>
  );
}

/** A control whose value is one of a fixed set, shown as pickable chips (current
 *  one marked). Picking a chip doesn't apply anything directly — it asks the agent
 *  to `set` that value, so a safe control applies and a risky one still surfaces a
 *  confirm card (the barrier holds; a chip is just a shortcut to typing it). */
function ChoiceCard({ o, t, onSend }: { o: ManageOutput; t: T; onSend?: (text: string) => void }) {
  const { title = "", value, options = [] } = o.data!;
  return (
    <CardShell>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((op) => {
          const active = op.value === value;
          return (
            <button
              key={op.value}
              type="button"
              disabled={active || !onSend}
              aria-pressed={active}
              onClick={() => { haptic("tap"); onSend?.(t("setInstruction", { title, value: op.label })); }}
              className={
                active
                  ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary"
                  : "rounded-full border border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
              }
            >
              {op.label}
            </button>
          );
        })}
      </div>
    </CardShell>
  );
}

/** A colored dot + localized word for a connector's state — no raw "oauth"/on/off
 *  jargon (PRODUCT.md forbids it for the non-technical audience). */
function StatusBadge({ enabled, status, t }: { enabled?: boolean; status?: string; t: T }) {
  const kind = enabled === false ? "off" : status === "oauth" ? "signin" : "on";
  const dot = kind === "on" ? "bg-emerald-500" : kind === "signin" ? "bg-amber-500" : "bg-muted-foreground/40";
  const label = kind === "off" ? t("statusOff") : kind === "signin" ? t("statusSignin") : t("statusOn");
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${enabled === false ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

export function ManageCard({ output, onSend }: { output: unknown; onSend?: (text: string) => void }) {
  const t = useTranslations("chat.manage");
  const o = output as ManageOutput;

  if (o?.render === "confirm" && o.preview) return <ConfirmCard o={o} t={t} onSend={onSend} />;

  if (o?.render === "setting" && o.data) return <SettingCard o={o} t={t} />;

  if (o?.render === "choice" && o.data?.options) return <ChoiceCard o={o} t={t} onSend={onSend} />;

  // OAuth / browser hand-off — the agent returned a URL only the user can open.
  if (o?.render === "action_required" && o.action) {
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ExternalLink className="h-4 w-4 text-muted-foreground" />
          {o.action.description ?? t("openHint")}
        </div>
        <div className="mt-3">
          <ConnectLink action={o.action} onConnected={onSend ? () => onSend(t("signedIn")) : undefined} />
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
            <ConnectLink
              action={o.data.action}
              onConnected={onSend ? () => onSend(t("recheckMsg", { name: o.data!.itemTitle ?? "" })) : undefined}
            />
          </div>
        )}
        {o.data.settingsPath && <SettingsLink href={o.data.settingsPath} t={t} />}
      </CardShell>
    );
  }

  if (o?.render === "debug" && o.data) {
    const itemTitle = o.data.itemTitle;
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          {t("debugTitle")}: {itemTitle}
        </div>
        <div className="mt-2 text-sm">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{o.data.state}</span>
        </div>
        {o.data.detail && <div className="mt-2 text-sm text-muted-foreground">{o.data.detail}</div>}
        {o.data.hint && <div className="mt-1 text-sm text-muted-foreground">{o.data.hint}</div>}
        {o.data.action && (
          <div className="mt-3">
            <ConnectLink
              action={o.data.action}
              onConnected={onSend && itemTitle ? () => onSend(t("recheckMsg", { name: itemTitle })) : undefined}
            />
          </div>
        )}
        {/* Close the OAuth loop: one tap re-runs the live probe via the agent. */}
        {onSend && itemTitle && (
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={() => onSend(t("recheckMsg", { name: itemTitle }))}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("recheck")}
            </Button>
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
          <div className="mt-2 text-sm text-muted-foreground">{t("emptyConnectors")}</div>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {items.map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{it.title}</span>
                  {it.subtitle && <span className="ml-2 truncate text-xs text-muted-foreground">{it.subtitle}</span>}
                </span>
                <StatusBadge enabled={it.enabled} status={it.status} t={t} />
              </li>
            ))}
          </ul>
        )}
        {o.data.settingsPath && <SettingsLink href={o.data.settingsPath} t={t} />}
      </CardShell>
    );
  }

  return null;
}
