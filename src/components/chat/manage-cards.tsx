import { useTranslations } from "next-intl";
import { Check, Undo2, AlertTriangle, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";

/** The subset of a `manage` tool result the chat renders as a card. Kept loose
 *  (all optional) because it arrives as opaque tool output. */
type ManageOutput = {
  render?: string;
  confirmToken?: string;
  preview?: { title: string; before: string; after: string; impact?: string };
  data?: { title: string; before: string; after: string; undoToken?: string };
};

/** A `manage` result becomes a prominent card (not a quiet rail step) only when
 *  it's something the user must SEE or ACT on: a confirmation request or an
 *  applied change. Everything else (lists, reads) stays in the activity rail. */
export function isManageCard(output: unknown): boolean {
  const r = (output as ManageOutput | null)?.render;
  return r === "confirm" || r === "setting";
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
    const { title, before, after, undoToken } = o.data;
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

  return null;
}
