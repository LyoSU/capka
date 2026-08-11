"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CircleQuestionMark, Loader2 } from "lucide-react";
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
    // Framing is STATE-DEPENDENT, and that's the whole point. While we're awaiting
    // an answer the run is suspended and the composer is blocked, so a user who
    // scrolls past this question is left typing into a dead box wondering why
    // nothing happens — this is the one moment the interface is obliged to
    // interrupt. It therefore sits on a raised surface with its state named in
    // words. Once answered it drops back to frameless prose, which is the calm,
    // woven-into-the-conversation treatment PRODUCT.md asks for. Calm is about not
    // shouting; it was never about hiding a question that blocks the work.
    <div
      className={
        awaiting
          ? "animate-blur-rise my-3 space-y-3 rounded-2xl bg-card p-4 shadow-raised"
          : "animate-blur-rise my-3 space-y-3"
      }
    >
      {awaiting && (
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CircleQuestionMark className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {/* Name the state. "Waiting on your decision" is the fact the user needs
              and cannot infer: that the agent has stopped, and that it stops until
              they act. The model's own title, if any, follows as the question. */}
          {t("waiting")}
        </div>
      )}
      {form.title && (
        <div className={awaiting ? "text-sm text-foreground" : "text-sm font-medium text-foreground"}>
          {form.title}
        </div>
      )}

      {awaiting ? (
        <>
          <div className="space-y-3">
            {form.fields.map((f) => (
              <Field
                key={f.id}
                field={f}
                value={values[f.id]}
                onSet={set}
                onToggle={toggle}
                // Enter in a text/number field submits, the way it does in the
                // composer right above. Without it the one-question case forces a
                // reach for the mouse mid-sentence.
                onEnter={() => { if (complete && !submitting) void send("submit"); }}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => send("submit")} disabled={submitting || !complete}>
              {/* The spinner lives INSIDE the button that caused it, not beside the
                  row: one locus of feedback for one action. */}
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t("submit")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => send("skip")} disabled={submitting}>{t("skip")}</Button>
            {/* Never disable a primary action without saying why — a dead button
                with no explanation reads as a broken interface, not as a rule. */}
            {!complete && !submitting && (
              <span className="text-xs text-muted-foreground">{t("needsAnswer")}</span>
            )}
          </div>
        </>
      ) : (
        // Settled: each question reads as a quiet label and its answer as a
        // right-aligned bubble — like the user's own reply woven into the chat. The
        // questions stay on the record (persisted forever).
        <div className="space-y-3">
          {form.fields.map((f) => (
            <div key={f.id} className="space-y-1.5">
              <div className="text-sm text-muted-foreground">{f.label}</div>
              {value?.action === "submit" && (
                <div className="flex justify-end">
                  <div className="inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-card px-4 py-2 text-sm text-card-foreground shadow-panel">
                    {display(f, value.values[f.id])}
                  </div>
                </div>
              )}
            </div>
          ))}
          {value?.action === "skip" && <div className="text-sm text-muted-foreground">{t("skipped")}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * A chip in the ask form. Two things here are deliberate and shared by both the
 * choice and yes/no cases:
 *
 *  - The selected state is a SOLID fill, not the 10% wash it used to be. This is a
 *    blocking decision that resumes suspended work, so "did my tap register?" must
 *    have no ambiguity; a faint tint on a pale surface leaves room for doubt.
 *  - `min-h-10 sm:min-h-8`: the old `py-1` chip stood ~26px tall. That clears the
 *    WCAG 2.1 AA floor but is a genuinely uncomfortable target for the single most
 *    consequential tap in the product, so touch gets a 40px row and the pointer
 *    case stays compact.
 */
const chipClass = (active: boolean) =>
  [
    "inline-flex min-h-10 items-center rounded-full px-3.5 text-sm transition-micro sm:min-h-8",
    active
      ? "bg-primary font-medium text-primary-foreground"
      : "bg-background text-muted-foreground shadow-btn hover:bg-hover hover:text-foreground",
  ].join(" ");

/** One field: a choice (single/multi chips), free text, a number, or a yes/no. */
function Field({ field, value, onSet, onToggle, onEnter }: {
  field: AskField;
  value: string | string[] | undefined;
  onSet: (id: string, v: string) => void;
  onToggle: (id: string, v: string) => void;
  onEnter?: () => void;
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
                className={chipClass(active)}
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
              className={chipClass(value === v)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <Input
          type={field.kind === "number" ? "number" : "text"}
          className="mt-2 h-10 sm:h-8"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onSet(field.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            e.preventDefault();
            onEnter?.();
          }}
        />
      )}
    </div>
  );
}
