"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, ChevronDown, Terminal } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * What an install or upgrade will reach, in the two registers §9 asks for: plain sentences
 * for everyone, and the exact detail behind an expander.
 *
 * The plain text is GENERATED from the same delta the technical view renders, never written
 * separately, so the two cannot drift — a reassuring sentence above an alarming detail is
 * the specific failure this structure prevents.
 *
 * The words "capability", "manifest" and "surface" do not appear in any string this file
 * renders, by rule.
 */

interface Endpoint {
  scheme: string;
  host: string;
  port: number;
  pathname: string;
  queryKeys: string[];
}

interface Connector {
  name: string;
  originKey: string;
  transport: "http" | "sse" | "stdio";
  endpoint?: Endpoint;
  authKind?: "token" | "oauth";
  secretKeys: string[];
  needsSecret: boolean;
  runsThirdPartyCode: boolean;
  bundled: boolean;
  activation: "forced_disabled" | "left_as_is" | "enabled" | "disabled";
  execution?: { binary: string; argCount: number; placeholderArgs: number[] };
}

interface DeltaEntry {
  resource: "connector" | "skill" | "files";
  key: string;
  name: string;
  kind: "unchanged" | "removal" | "expansion" | "attenuation" | "replacement" | "unknown";
  aspects: ("credential" | "command" | "endpoint" | "instructions" | "files" | "activation")[];
}

export interface PluginReview {
  reviewHash: string;
  gate: "no_consent" | "requires_consent" | "cannot_apply";
  surface: { connectors: Connector[]; skills: { name: string; originPath: string }[]; files: { count: number; bytes: number; entrypoints: string[] } };
  delta: { upstream: DeltaEntry[]; effective: DeltaEntry[]; kinds: string[] };
  observations: { urls: Record<string, string> };
  notes: string[];
  /** The literal command lines — present only in the response to the authorized installer,
   *  and the one thing here that is not redacted. They are the SUBJECT of the review:
   *  hiding what code runs would make reading this pointless. */
  execution: { connectorName: string; command: string; args: string[] }[];
}

export interface PolicyOutlook {
  key: string;
  capabilityType: "skill" | "connector";
  capabilityKey: string;
  effect: string;
  outlook: "still_applies" | "applies_to_nothing";
}

/** `scheme://host:port/path` plus parameter NAMES. Never a value, never URL credentials —
 *  not even in the expander, so it cannot become a loophole. */
function endpointText(e: Endpoint): string {
  const q = e.queryKeys.length ? `?${e.queryKeys.join("&")}` : "";
  return `${e.scheme}://${e.host}:${e.port}${e.pathname}${q}`;
}

export function PluginReviewPanel({
  review, policies, dispositions, onDisposition,
}: {
  review: PluginReview;
  policies: PolicyOutlook[];
  dispositions: Record<string, "keep" | "delete">;
  onDisposition: (key: string, value: "keep" | "delete") => void;
}) {
  const t = useTranslations("settings.skills.installed.review");

  // `effective` is what applying would overwrite, so it is the default view. `upstream` is
  // surfaced only as a note when the two differ — that difference means a local edit or an
  // unfinished apply, which is worth naming but not worth a second list.
  const rows = review.delta.effective.filter((e) => e.kind !== "unchanged");
  const locallyModified = review.delta.effective.some((e) =>
    e.kind === "replacement" && !review.delta.upstream.some((u) => u.key === e.key && u.kind === "replacement"));
  const runsCode = review.surface.connectors.some((c) => c.runsThirdPartyCode);
  const byName = new Map(review.execution.map((e) => [e.connectorName, e]));

  const sentence = (e: DeltaEntry): string => {
    if (e.kind === "unknown") return t("unknownBaseline", { name: e.name });
    if (e.kind === "attenuation") return t("disabledConnector", { name: e.name });
    if (e.kind === "expansion") {
      if (e.resource === "files") return t("addedFiles");
      if (e.resource === "skill") return t("addedSkill", { name: e.name });
      const c = review.surface.connectors.find((x) => x.originKey === e.key);
      return c?.runsThirdPartyCode ? t("addedProgram", { name: e.name }) : t("addedConnector", { name: e.name });
    }
    if (e.kind === "removal") {
      if (e.resource === "files") return t("removedFiles");
      return e.resource === "skill" ? t("removedSkill", { name: e.name }) : t("removedConnector", { name: e.name });
    }
    // A replacement names WHAT changed rather than saying "changed": the aspect is the
    // whole information content of the row.
    if (e.aspects.includes("command")) return t("changedCommand", { name: e.name });
    if (e.aspects.includes("endpoint")) return t("changedEndpoint", { name: e.name });
    if (e.aspects.includes("credential")) return t("changedCredential", { name: e.name });
    if (e.aspects.includes("instructions")) return t("changedInstructions", { name: e.name });
    if (e.aspects.includes("files")) return t("changedFiles", { name: e.name });
    return t("changedOther", { name: e.name });
  };

  return (
    <div className="space-y-3">
      {/* `text-destructive-text`, not `text-destructive`: the latter is the FILL colour,
          meant for a solid button, and on a 10% tint it measures 3.98:1 — below AA. The
          -text token exists for exactly this pairing (see usage-limit-card.tsx). */}
      {review.gate === "cannot_apply" && (
        <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive-text">
          <p className="font-medium">{t("cannotApply")}</p>
          <p className="mt-1">{t("cannotApplyBody")}</p>
        </div>
      )}

      {/* Above the list, not as a diff row: it is true of the plugin as a whole, and a row
          would let it scroll out of sight among the changes. */}
      {runsCode && (
        <div className="flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-xs text-warning-text">
          <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">{t("sandboxTitle")}</p>
            <p>{t("sandboxBody")}</p>
            {/* No project list: it goes stale, and a personal owner has no business seeing
                org project names. */}
            <p>{t("sandboxNetwork")}</p>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("nothingChanges")}</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {rows.map((e) => (
            <li key={`${e.resource}:${e.key}`} className="flex items-start gap-1.5">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" />
              <span>{sentence(e)}</span>
            </li>
          ))}
        </ul>
      )}

      {locallyModified && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("localModifications")}
        </p>
      )}

      {policies.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">{t("policiesTitle")}</p>
          {policies.map((p) => (
            <div key={p.key} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {p.outlook === "still_applies"
                  ? t("policyStillApplies", { name: p.capabilityKey })
                  : t("policyAppliesToNothing", { name: p.capabilityKey })}
              </span>
              {/* Only offered where it is a real choice: while a resource of that name still
                  answers to the rule, deleting it would change something the review is not
                  about. */}
              {p.outlook === "applies_to_nothing" && (
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={dispositions[p.key] === "delete"}
                    onChange={(ev) => onDisposition(p.key, ev.target.checked ? "delete" : "keep")}
                  />
                  <span>{t("policyDelete")}</span>
                </label>
              )}
            </div>
          ))}
        </div>
      )}

      <Collapsible>
        <CollapsibleTrigger className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&[data-panel-open]_.chevron]:rotate-180">
          {t("details")}
          <ChevronDown className="chevron h-3.5 w-3.5 transition-transform" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2 text-xs">
          {review.surface.connectors.map((c) => {
            const exec = byName.get(c.name);
            return (
              <div key={c.originKey} className="space-y-0.5 rounded-lg bg-muted p-2">
                <p className="font-medium">{c.name}</p>
                {c.endpoint && (
                  <p className="break-all text-muted-foreground">
                    {t("endpointLabel")}: <span className="font-mono">{endpointText(c.endpoint)}</span>
                  </p>
                )}
                {exec && (
                  <p className="break-all text-muted-foreground">
                    {t("commandLabel")}: <span className="font-mono">{[exec.command, ...exec.args].join(" ")}</span>
                  </p>
                )}
                <p className="text-muted-foreground">
                  {c.secretKeys.length
                    ? `${t("secretsLabel")}: ${c.secretKeys.join(", ")}${c.needsSecret ? ` — ${t("needsSecret")}` : ""}`
                    : t("secretsNone")}
                </p>
              </div>
            );
          })}
          {review.surface.skills.map((s) => (
            <div key={s.name} className="rounded-lg bg-muted p-2">
              <p className="font-medium">{s.name}</p>
              <p className="font-mono text-muted-foreground">{s.originPath}</p>
            </div>
          ))}
          {review.notes.map((n, i) => (
            <p key={i} className="text-muted-foreground">{n}</p>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
