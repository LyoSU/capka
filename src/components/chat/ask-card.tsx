"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { HelpCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { haptic } from "@/lib/haptics";
import type { AskForm, AskField, AskAnswer } from "@/lib/ask/types";

/**
 * Renders a suspended `ask` question (or an MCP elicitation) as an inline form and
 * posts the user's answer, which resumes the SAME turn. Mirrors ApprovalCard: the
 * card owns the whole interaction — the composer is blocked meanwhile (see
 * useBackgroundChat.awaitingInput), so this is the one next action. When answered
 * it collapses to a quiet summary line.
 *
 * `kind` routes the answer: "ask" (default) resolves a suspended tool call;
 * "elicitation" writes the block-and-poll row an MCP tool is waiting on. For an
 * elicitation there is no persisted tool-call part, so `toolCallId` is omitted and
 * the server matches by messageId.
 */
export function AskCard({
  messageId, toolCallId, form, value, state, kind = "ask",
}: {
  messageId: string; toolCallId?: string; form: AskForm; value?: AskAnswer; state: string; kind?: "ask" | "elicitation";
}) {
  const t = useTranslations("chat.ask");
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const awaiting = state === "input-available" && !value;

  // Turn a stored answer value into its human label (choice → option label,
  // boolean → yes/no, multi → joined) for the settled view.
  const display = (field: AskField, v: string | string[] | undefined): string => {
    if (v == null || v === "") return "—";
    const one = (val: string) =>
      field.kind === "boolean" ? (val === "true" ? t("yes") : t("no"))
      : field.kind === "choice" ? (field.options?.find((o) => o.value === val)?.label ?? val)
      : val;
    return Array.isArray(v) ? v.map(one).join(", ") : one(v);
  };

  const set = (id: string, v: string | string[]) => setValues((prev) => ({ ...prev, [id]: v }));
  const toggle = (id: string, v: string) => {
    const cur = Array.isArray(values[id]) ? (values[id] as string[]) : [];
    set(id, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };

  const complete = form.fields.filter((f) => !f.optional).every((f) => {
    const v = values[f.id];
    return Array.isArray(v) ? v.length > 0 : (v ?? "") !== "";
  });

  const send = async (action: "submit" | "skip") => {
    if (submitting) return;
    setSubmitting(true);
    haptic(action === "submit" ? "success" : "tap");
    try {
      await fetch("/api/ask/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, toolCallId, action, values: action === "submit" ? values : {}, kind }),
      });
      // The resume turn (ask) or the unblocked MCP tool (elicitation) now runs; its
      // realtime updates + the finish reload settle this card. No local phase.
    } catch {
      setSubmitting(false); // let the user retry the click
    }
  };

  return (
    <div className="animate-blur-rise my-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <HelpCircle className="h-4 w-4 text-muted-foreground" />
        {form.title ?? t("title")}
      </div>

      {awaiting ? (
        <>
          <div className="mt-3 space-y-3">
            {form.fields.map((f) => (
              <Field key={f.id} field={f} value={values[f.id]} onSet={set} onToggle={toggle} />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => send("submit")} disabled={submitting || !complete}>{t("submit")}</Button>
            <Button size="sm" variant="ghost" onClick={() => send("skip")} disabled={submitting}>{t("skip")}</Button>
            {submitting && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </>
      ) : (
        // Settled: the questions stay on the record (they persist forever), and each
        // answer renders as its own message-like bubble on the right — so it's clear
        // what was asked AND what the user replied.
        <div className="mt-3 space-y-3">
          {form.fields.map((f) => (
            <div key={f.id}>
              <div className="text-sm text-muted-foreground">{f.label}</div>
              {value?.action === "submit" ? (
                <div className="mt-1.5 flex justify-end">
                  <div className="inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-border bg-card px-4 py-2 text-sm text-card-foreground shadow-sm">
                    {display(f, value.values[f.id])}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
          {value?.action === "skip" && <div className="text-sm text-muted-foreground">{t("skipped")}</div>}
        </div>
      )}
    </div>
  );
}

/** One field: a choice (single/multi chips), free text, a number, or a yes/no. */
function Field({ field, value, onSet, onToggle }: {
  field: AskField;
  value: string | string[] | undefined;
  onSet: (id: string, v: string) => void;
  onToggle: (id: string, v: string) => void;
}) {
  const t = useTranslations("chat.ask");
  return (
    <div>
      <div className="text-sm text-foreground">{field.label}</div>
      {field.kind === "choice" && field.options ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {field.options.map((op) => {
            const active = field.multi ? Array.isArray(value) && value.includes(op.value) : value === op.value;
            return (
              <button
                key={op.value}
                type="button"
                aria-pressed={active}
                onClick={() => { haptic("tap"); if (field.multi) onToggle(field.id, op.value); else onSet(field.id, op.value); }}
                className={
                  active
                    ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary"
                    : "rounded-full border border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                }
              >
                {op.label}
              </button>
            );
          })}
        </div>
      ) : field.kind === "boolean" ? (
        <div className="mt-2 flex gap-2">
          {[["true", t("yes")], ["false", t("no")]].map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={value === v}
              onClick={() => { haptic("tap"); onSet(field.id, v); }}
              className={
                value === v
                  ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary"
                  : "rounded-full border border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
              }
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <Input
          type={field.kind === "number" ? "number" : "text"}
          className="mt-2"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onSet(field.id, e.target.value)}
        />
      )}
    </div>
  );
}
