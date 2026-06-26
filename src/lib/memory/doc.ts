import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { log } from "@/lib/log";
import { toTokenUsage, type TokenUsage } from "@/lib/pricing";
import { buildAuxRequest } from "@/lib/chat/context/aux";
import { isReasoningUnsupportedError } from "@/lib/errors/friendly";
import { MEMORY_DOC_MAX_CHARS, MEMORY_CONSOLIDATE_EVERY } from "@/lib/constants";

/** A scope is one memory document: the user-global doc or a single project's. */
export type MemoryScope = "user" | "project";

/** One line-level edit against a memory document. The MODEL decides which ops to
 *  emit; `applyMemoryOps` applies them deterministically, so the blast radius of
 *  a bad turn is one line, never the whole doc (that's what consolidation is for). */
export type MemoryOp =
  | { op: "add"; text: string }
  | { op: "replace"; old: string; new: string }
  | { op: "remove"; text: string };

// ── Pure helpers (no LLM, no DB — the tested core) ──────────────────────────

/** Match key for dedup/replace/remove: lowercased, bullet-stripped, ws-collapsed. */
function normalize(line: string): string {
  return line.replace(/^[-*]\s*/, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Render a fact as a single clean bullet line. */
function bullet(text: string): string {
  return `- ${text.replace(/^[-*]\s*/, "").replace(/\s+/g, " ").trim()}`;
}

/**
 * Parse the model's reconcile output into ops. Tolerant by design: the model
 * may wrap the array in prose or a code fence, so we take the first `[` … last
 * `]`. Anything malformed yields `[]` (a safe no-op) rather than throwing.
 */
export function parseMemoryOps(raw: string): MemoryOp[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ops: MemoryOp[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.op === "add" && typeof o.text === "string" && o.text.trim()) {
      ops.push({ op: "add", text: o.text });
    } else if (o.op === "remove" && typeof o.text === "string" && o.text.trim()) {
      ops.push({ op: "remove", text: o.text });
    } else if (o.op === "replace" && typeof o.old === "string" && typeof o.new === "string" && o.new.trim()) {
      ops.push({ op: "replace", old: o.old, new: o.new });
    }
  }
  return ops;
}

/**
 * Apply ops to a doc and return the new doc — deterministic, append-biased,
 * clamped to the size ceiling. `add` is skipped when an existing line already
 * covers it (substring either way), so a chatty model can't grow the doc with
 * near-duplicates; consolidation does the deeper merge later.
 */
export function applyMemoryOps(doc: string, ops: MemoryOp[]): string {
  let lines = doc.split("\n").filter((l) => l.trim());
  for (const op of ops) {
    if (op.op === "remove") {
      const key = normalize(op.text);
      if (key) lines = lines.filter((l) => !normalize(l).includes(key));
    } else if (op.op === "replace") {
      const key = normalize(op.old);
      let replaced = false;
      lines = lines.map((l) => {
        if (!replaced && key && normalize(l).includes(key)) {
          replaced = true;
          return bullet(op.new);
        }
        return l;
      });
      if (!replaced) lines.push(bullet(op.new)); // superseding a fact we don't have → just add it
    } else {
      const key = normalize(op.text);
      if (!key) continue;
      const dup = lines.some((l) => {
        const ln = normalize(l);
        return ln.includes(key) || key.includes(ln);
      });
      if (!dup) lines.push(bullet(op.text));
    }
  }
  return clampDoc(lines.join("\n"));
}

/** Hard size guard: drop the oldest lines (top) until under the ceiling. The
 *  per-turn path relies on this so a runaway turn can never overflow the prompt;
 *  consolidation is the graceful path, this is the backstop. */
export function clampDoc(doc: string): string {
  const lines = doc.split("\n").filter((l) => l.trim());
  while (lines.join("\n").length > MEMORY_DOC_MAX_CHARS && lines.length > 1) {
    lines.shift();
  }
  return lines.join("\n");
}

/** Trigger for the expensive full rewrite: too big, or enough turns have piled
 *  up that line-level edits have likely left cruft worth reorganizing. */
export function needsConsolidation(doc: string, turnsSince: number): boolean {
  return doc.length > MEMORY_DOC_MAX_CHARS || turnsSince >= MEMORY_CONSOLIDATE_EVERY;
}

// ── LLM passes ──────────────────────────────────────────────────────────────

export interface ConversationTurn {
  userText: string;
  assistantText?: string;
}

/**
 * Reasoning is pointless for these mechanical extraction calls and — worse — on
 * an always-thinking model the thinking tokens eat the output budget before any
 * answer lands (reconcile → empty ops, consolidate → truncated rewrite). So we
 * ask each provider for the least/no reasoning. Mirror image of the runner's
 * reasoningOptions(); unknown providers keep their default.
 */
function auxReasoningOptions(provider: string): Record<string, Record<string, unknown>> | undefined {
  switch (provider) {
    case "anthropic": return { anthropic: { thinking: { type: "disabled" } } };
    case "openrouter": return { openrouter: { reasoning: { enabled: false } } };
    case "openai": return { openai: { reasoningEffort: "low" } };
    case "google": return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    case "litellm":
    case "deepseek":
    case "mistral":
    case "xai":
    case "zhipu": return { [provider]: { reasoningEffort: "low" } };
    default: return undefined;
  }
}

type AuxArgs =
  | { messages: ModelMessage[]; maxOutputTokens: number }
  | { system: string; prompt: string; maxOutputTokens: number };

/** generateText for aux calls: suppress reasoning, but if a non-reasoning model
 *  rejects the knob (gpt-4o, claude-3.5…), retry once without it — same
 *  optimistic-then-fallback philosophy as the main run. */
async function auxGenerate(model: LanguageModel, provider: string, args: AuxArgs) {
  const providerOptions = auxReasoningOptions(provider);
  try {
    return await generateText({ model, ...args, ...(providerOptions ? { providerOptions: providerOptions as never } : {}) });
  } catch (e) {
    if (providerOptions && isReasoningUnsupportedError(e)) return await generateText({ model, ...args });
    throw e;
  }
}

const SCOPE_TARGET: Record<MemoryScope, string> = {
  user: "durable facts, preferences, and work context about the USER",
  project: "durable facts, decisions, conventions, and gotchas about THIS project and the work in it",
};

function reconcileInstruction(scope: MemoryScope, doc: string): string {
  return (
    `You maintain a long-term memory document of ${SCOPE_TARGET[scope]}.\n\n` +
    `Current memory document:\n${doc.trim() || "(empty)"}\n\n` +
    `Return a JSON array of edit operations to fold in anything new from the latest turn:\n` +
    `- {"op":"add","text":"…"} — a NEW durable fact not already present\n` +
    `- {"op":"replace","old":"…","new":"…"} — a fact that supersedes/refines an existing line ("old" = a distinctive substring of that line)\n` +
    `- {"op":"remove","text":"…"} — a line now wrong or obsolete ("text" = a distinctive substring)\n\n` +
    `Rules: only durable, reusable facts — never transient chatter, task mechanics, or anything already in the document. ` +
    `Each fact one concise line. If nothing is worth changing, output []. Output ONLY the JSON array, nothing else.`
  );
}

/**
 * Mine the just-finished turn for memory edits. Returns ops (the caller applies
 * + persists them, keeping this side-effect-free and the apply path pure).
 *
 * Cost-shaped exactly like the old extractor: on a long chat it rides the warm
 * system+history prefix (`hotContext`) so it sees the full conversation at
 * cache-read price; on a short chat a small standalone call is cheaper. Spend is
 * reported via `onUsage` so it bills against the same key/budget as the turn.
 */
export async function reconcileMemoryDoc(
  model: LanguageModel,
  provider: string,
  scope: MemoryScope,
  doc: string,
  turn: ConversationTurn,
  onUsage?: (usage: TokenUsage) => void,
  hotContext?: { systemMessages: ModelMessage[]; modelMessages: ModelMessage[] },
): Promise<MemoryOp[]> {
  const userText = (turn.userText ?? "").trim();
  if (!hotContext && userText.length < 20) return [];

  const instruction = reconcileInstruction(scope, doc);
  try {
    const { text, usage } = await auxGenerate(
      model,
      provider,
      hotContext
        ? {
            messages: buildAuxRequest(hotContext.systemMessages, hotContext.modelMessages, turn.assistantText ?? "", instruction),
            maxOutputTokens: 512,
          }
        : {
            system: instruction,
            prompt:
              `Latest turn:\nUser: ${userText.slice(0, 2000)}` +
              (turn.assistantText?.trim() ? `\nAssistant: ${turn.assistantText.trim().slice(0, 1000)}` : ""),
            maxOutputTokens: 512,
          },
    );

    const billable = toTokenUsage(usage);
    if (billable && onUsage) onUsage(billable);
    return parseMemoryOps(text);
  } catch (e) {
    log.error("memory reconcile failed", { err: String(e) });
    return [];
  }
}

const CONSOLIDATE_PROMPT =
  `Rewrite this long-term memory document so it stays an accurate, compact set of durable facts. ` +
  `Merge duplicates and near-duplicates, drop anything contradicted or obsolete, and group related lines together. ` +
  `Preserve every still-valid specific — do NOT generalize details away. One fact per line as "- …". ` +
  `Output ONLY the rewritten document, nothing else.`;

/**
 * The expensive, rare path: a full rewrite that reorganizes and dedups the doc.
 * Gated by `needsConsolidation`. Always clamped — a model that ignores the size
 * hint still can't blow the ceiling. Returns the original on any failure so a
 * flaky consolidation never wipes memory.
 */
export async function consolidateMemoryDoc(
  model: LanguageModel,
  provider: string,
  doc: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<string> {
  if (!doc.trim()) return doc;
  try {
    const { text, usage, finishReason } = await auxGenerate(model, provider, {
      system: CONSOLIDATE_PROMPT,
      prompt: doc,
      // The rewrite reproduces the whole doc, so the budget must cover the full
      // size ceiling — generous because Cyrillic tokenizes well under 1 char/token.
      maxOutputTokens: MEMORY_DOC_MAX_CHARS,
    });
    const billable = toTokenUsage(usage);
    if (billable && onUsage) onUsage(billable);
    // A truncated rewrite would silently drop facts (and we'd then persist it
    // over the good copy) — refuse it and keep the original instead.
    if (finishReason === "length") return doc;
    const rewritten = text.trim();
    return rewritten ? clampDoc(rewritten) : doc;
  } catch (e) {
    log.error("memory consolidation failed", { err: String(e) });
    return doc;
  }
}
