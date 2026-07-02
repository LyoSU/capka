import type { AskForm, AskField, AskAnswer } from "./types";

/** Map an MCP elicitation `requestedSchema` (a flat object of primitive props)
 *  onto our form. Per the MCP spec: string/number/integer/boolean/enum only. */
export function elicitSchemaToForm(requestedSchema: unknown, message?: string): AskForm {
  const s = (requestedSchema ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const required = new Set(s.required ?? []);
  const fields: AskField[] = Object.entries(s.properties ?? {}).map(([id, p]) => {
    const label = String(p.title ?? p.description ?? id);
    const optional = !required.has(id);
    if (Array.isArray(p.enum)) {
      const enumNames = Array.isArray(p.enumNames) ? (p.enumNames as string[]) : undefined;
      return {
        id, label, kind: "choice", optional,
        options: (p.enum as unknown[]).map((v, i) => ({ value: String(v), label: String(enumNames?.[i] ?? v) })),
      };
    }
    const type = p.type as string;
    const kind: AskField["kind"] = type === "boolean" ? "boolean" : type === "number" || type === "integer" ? "number" : "text";
    return { id, label, kind, optional };
  });
  return {
    ...(message ? { title: message } : {}),
    // An empty schema still needs one field so the card renders something to answer.
    fields: fields.length ? fields : [{ id: "value", label: message ?? "Your answer", kind: "text" }],
  };
}

/** Map the user's answer onto an MCP ElicitResult. submit→accept, skip→decline
 *  (timeout→cancel is decided by the caller, not here). */
export function answerToElicitResult(a: AskAnswer): { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } {
  return a.action === "submit" ? { action: "accept", content: a.values } : { action: "decline" };
}
