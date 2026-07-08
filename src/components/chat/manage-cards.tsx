import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Check, Undo2, AlertTriangle, SlidersHorizontal, ExternalLink, Stethoscope, Plug, Trash2, Power, Loader2, RefreshCw, ArrowUpRight, FilePen, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import type { StepTranslator } from "@/lib/chat/steps";

type RequiredAction = { kind: string; url?: string; label: string; description?: string };

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
  preview?: { title: string; before: string; after: string; impact?: string; details?: string; body?: string; items?: string[] };
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
    op?: "added" | "removed" | "enabled" | "disabled" | "editing";
    itemTitle?: string;
    action?: RequiredAction;
    // debug
    state?: string;
    detail?: string;
    hint?: string;
  };
};

const CARD_RENDERS = new Set(["confirm", "choice", "action_required"]);

/** A `manage` result becomes a prominent card only when the user must still ACT on
 *  it — a confirmation, a chip picker, or an OAuth/open-url hand-off. Everything the
 *  agent merely *did* (an applied setting, an enable/disable, a healthy diagnostic)
 *  and every internal read (a value, the registry list, a collection's items) drops
 *  to the quiet activity rail, where it reads as a one-line step (see
 *  `manageStepLabel`). Two results carry an action even though their render isn't in
 *  the always-card set, so they stay cards: a `setting` change that must refresh the
 *  route (a locale switch), and a `resource`/`debug` with a sign-in button attached. */
export function isManageCard(output: unknown): boolean {
  const o = output as ManageOutput | null;
  const r = o?.render;
  if (!r) return false;
  if (CARD_RENDERS.has(r)) return true;
  if (r === "setting") return !!o!.data?.reload; // a locale switch needs the visible card + route refresh
  if (r === "resource" || r === "debug") return !!o!.data?.action; // keep only when a sign-in button rides along
  return false;
}

/** A demoted `manage` result rendered as a quiet one-line rail step. Mutations and
 *  single-value reads carry their own localized `summary` ("Enabled X", "Language:
 *  Ukrainian"); a whole-collection read is named by its domain (Connectors/Skills/…)
 *  so it doesn't collapse into the generic "settings" step. `list`/`capabilities`
 *  are genuinely cross-domain overviews and fall back to the generic read label. */
export function manageStepLabel(output: unknown, t: StepTranslator): string | null {
  const o = output as ManageOutput | null;
  switch (o?.render) {
    case "setting":
    case "debug":
    case "value":
      return o.summary ?? null;
    case "resource":
      // `editing` (skill checked out) summarises as a long model instruction — show
      // just the item name; the rest are short localized lines ("Enabled X").
      return o.data?.op === "editing" ? (o.data.itemTitle ?? null) : (o.summary ?? null);
    case "collection":
      // Name the domain read (e.g. "Reviewed connectors"). The server `summary`
      // carries a model-facing "(you can add here)" hint, so use the clean title.
      return o.data?.title ? t("reviewedNamed", { name: o.data.title }) : null;
    default:
      return null;
  }
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
    if (action.kind !== "oauth" || !action.url) return; // open_url: let the anchor navigate normally
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

/** The agent asked the user to pick a folder from their own computer — only the
 *  browser can open that picker. Opens it, creates the folder row, and runs a
 *  first sync (all in the bridge). Needs the chatId to key the sandbox side. */
function PickFolderButton({ chatId, action, onPicked }: { chatId?: string; action: RequiredAction; onPicked?: (name: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!chatId) return null;
  const onClick = async () => {
    setBusy(true);
    setErr("");
    try {
      const { pickAndCreate } = await import("@/lib/folder-bridge/bridge");
      const folder = await pickAndCreate(chatId);
      if (folder) onPicked?.(folder.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not attach the folder.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button size="sm" onClick={onClick} disabled={busy} className="gap-1.5">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
        {action.label}
      </Button>
      {err && <div className="mt-1.5 text-xs text-destructive">{err}</div>}
    </div>
  );
}

const OP_ICON = { added: Plug, removed: Trash2, enabled: Power, disabled: Power, editing: FilePen } as const;

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
function ConfirmCard({ o, t, onSend, chatId }: { o: ManageOutput; t: T; onSend?: (text: string) => void; chatId?: string }) {
  const { title, before, after, impact, details, body, items } = o.preview!;
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
      {/* The full SET being approved (e.g. every skill a repo would install) — so a
          bulk install is never confirmed as an opaque "add repo". */}
      {items && items.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {items.map((it) => (
            <li key={it} className="flex items-center gap-2">
              <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
              {it}
            </li>
          ))}
        </ul>
      )}
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
          {/* e.g. "Connect" after adding an OAuth connector, or "Choose a folder"
              after attaching a PC folder — resolved without leaving chat. */}
          {followUp && (
            <div className="mt-3">
              {followUp.kind === "pick_folder"
                ? <PickFolderButton chatId={chatId} action={followUp} onPicked={onSend ? (name) => onSend(t("folderPicked", { name })) : undefined} />
                : <ConnectLink action={followUp} onConnected={onSend ? () => onSend(t("signedIn")) : undefined} />}
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

type Preview = { title: string; before: string; after: string; impact?: string; details?: string; body?: string; items?: string[] };

/**
 * Native human-in-the-loop approval for a suspended `manage` tool call. Unlike the
 * old ConfirmCard (which drove a staged pending id), this card is a renderer of the
 * tool part's own approval state — Approve/Reject POST a decision that RESUMES the
 * agent turn (it re-runs the tool and finishes, or acknowledges the denial), and
 * the resolved state arrives back as a normal part update. While awaiting, it
 * fetches the before→after preview from the call's input (the same rich data the
 * confirm card showed, incl. a connector's live tool-count probe). The composer is
 * blocked meanwhile (see useBackgroundChat.awaitingApproval), so this is the one
 * next action — no "press confirm" prose, no stale card.
 */
export function ApprovalCard({
  messageId, toolCallId, input, state, approval, output, onSend,
}: {
  messageId: string; toolCallId: string; input: unknown; state: string;
  approval?: { id: string; approved?: boolean; reason?: string }; output?: unknown; onSend?: (text: string) => void;
}) {
  const t = useTranslations("chat.manage");
  const awaiting = state === "approval-requested";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fetch the preview only while awaiting — a resolved card shows the applied
  // result's own summary instead, so we never re-probe a connector after the fact.
  useEffect(() => {
    if (!awaiting) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/manage/preview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          // messageId lets the server recover the run's sandbox session so a
          // workspace-path preview (skill add {path}) lists the real skills.
          body: JSON.stringify({ input, messageId }),
        });
        const { preview } = (await res.json()) as { preview: Preview | null };
        if (alive && preview) setPreview(preview);
      } catch { /* fall back to the header alone */ }
    })();
    return () => { alive = false; };
  }, [awaiting, input, messageId]);

  const decide = async (approved: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    haptic(approved ? "success" : "tap");
    try {
      await fetch("/api/manage/approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, toolCallId, approved }),
      });
      // The resume turn now runs; its realtime updates (and the finish reload) flip
      // this part to its resolved state, which re-renders the card. No local phase.
    } catch {
      setSubmitting(false); // let the user retry the click
    }
  };

  const oo = output as ManageOutput | null;
  const followUp = oo?.data?.action ?? oo?.action ?? null;

  return (
    <CardShell>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        {t("confirmTitle")}
      </div>

      {awaiting && (
        <>
          {preview ? (
            <>
              <div className="mt-2 text-sm text-muted-foreground">{preview.title}</div>
              <Diff before={preview.before} after={preview.after} />
              {preview.items && preview.items.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {preview.items.map((it) => (
                    <li key={it} className="flex items-center gap-2">
                      <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
                      {it}
                    </li>
                  ))}
                </ul>
              )}
              {preview.details && <div className="mt-2 text-sm text-muted-foreground">{preview.details}</div>}
              {preview.body && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t("viewInstructions")}</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 text-xs text-muted-foreground">{preview.body}</pre>
                </details>
              )}
              {preview.impact && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{preview.impact}</span>
                </div>
              )}
            </>
          ) : (
            <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />{t("checking")}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => decide(true)} disabled={submitting}>{t("apply")}</Button>
            <Button size="sm" variant="ghost" onClick={() => decide(false)} disabled={submitting}>{t("cancel")}</Button>
          </div>
        </>
      )}

      {/* Resolved states — the agent's follow-up text carries the details, so the
          card settles into a quiet confirmation. Approved-but-still-running shows a
          spinner; a denied call reads "declined"; an applied one shows its summary. */}
      {!awaiting && approval?.approved === true && state !== "output-available" && state !== "output-error" && (
        <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />{t("applying")}
        </div>
      )}
      {!awaiting && approval?.approved === false && <Outcome kind="cancelled" text={t("declined")} />}
      {!awaiting && state === "output-available" && (
        <>
          {oo?.summary && <div className="mt-2 text-sm text-muted-foreground">{oo.summary}</div>}
          <Outcome kind="done" text={t("confirmed")} />
          {followUp && (
            <div className="mt-3">
              <ConnectLink action={followUp} onConnected={onSend ? () => onSend(t("signedIn")) : undefined} />
            </div>
          )}
        </>
      )}
      {!awaiting && state === "output-error" && <Outcome kind="error" text={oo?.summary || t("applyError")} />}
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
export function ManageCard({ output, onSend, chatId }: { output: unknown; onSend?: (text: string) => void; chatId?: string }) {
  const t = useTranslations("chat.manage");
  const o = output as ManageOutput;

  if (o?.render === "confirm" && o.preview) return <ConfirmCard o={o} t={t} onSend={onSend} chatId={chatId} />;

  if (o?.render === "setting" && o.data) return <SettingCard o={o} t={t} />;

  if (o?.render === "choice" && o.data?.options) return <ChoiceCard o={o} t={t} onSend={onSend} />;

  // OAuth / browser hand-off — the agent returned an action only the user can do
  // (open an OAuth URL, or pick a folder from their own computer).
  if (o?.render === "action_required" && o.action) {
    const isPick = o.action.kind === "pick_folder";
    return (
      <CardShell>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {isPick ? <FolderPlus className="h-4 w-4 text-muted-foreground" /> : <ExternalLink className="h-4 w-4 text-muted-foreground" />}
          {o.action.description ?? (isPick ? t("pickFolderHint") : t("openHint"))}
        </div>
        <div className="mt-3">
          {isPick
            ? <PickFolderButton chatId={chatId} action={o.action} onPicked={onSend ? (name) => onSend(t("folderPicked", { name })) : undefined} />
            : <ConnectLink action={o.action} onConnected={onSend ? () => onSend(t("signedIn")) : undefined} />}
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
            {o.data.action.kind === "pick_folder"
              ? <PickFolderButton chatId={chatId} action={o.data.action} onPicked={onSend ? (name) => onSend(t("folderPicked", { name })) : undefined} />
              : <ConnectLink
                  action={o.data.action}
                  onConnected={onSend ? () => onSend(t("recheckMsg", { name: o.data!.itemTitle ?? "" })) : undefined}
                />}
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

  return null;
}
