import type { ComponentType } from "react";
import {
  FilePlus, FilePen, FileText, Folder, Search, Terminal, Code, Globe, Wrench,
} from "lucide-react";

export type StepIcon = ComponentType<{ className?: string }>;

/** A minimal translator shape (next-intl's `useTranslations("steps")`),
 *  decoupled so this module doesn't depend on next-intl's exact types. */
export type StepTranslator = (key: string, values?: Record<string, string | number>) => string;

export interface StepDescriptor {
  Icon: StepIcon;
  /** Past-tense, with the concrete object: "Created logo.svg". */
  label: string;
  /** Present-tense for the running state: "Creating logo.svg…". */
  activeLabel: string;
  /** Optional dim trailing detail (e.g. the command that ran). */
  detail?: string;
}

const basename = (p: unknown): string => {
  const s = typeof p === "string" ? p : "";
  const trimmed = s.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed || "file";
};

const clip = (s: unknown, n = 48): string => {
  const str = typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";
  return str.length > n ? str.slice(0, n) + "…" : str;
};

/** snake_case / kebab tool name → "Title Case" words, for unknown/MCP tools. */
function prettyToolName(name: string): string {
  const words = name.replace(/^mcp[_-]/i, "").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Map a tool call to a human-readable step — the single place that turns our
 * tool names + args into the "Created logo.svg" / "Ran command" lines a
 * non-technical user understands. Shared by the chat transcript and the
 * progress panel so they never describe the same action differently.
 */
export function describeStep(t: StepTranslator, toolName: string, input?: unknown): StepDescriptor {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = toolName.toLowerCase();

  switch (name) {
    case "write_file": {
      const file = basename(args.path);
      return { Icon: FilePlus, label: t("createdFile", { file }), activeLabel: t("creatingFile", { file }) };
    }
    case "str_replace": {
      const file = basename(args.path);
      return { Icon: FilePen, label: t("editedFile", { file }), activeLabel: t("editingFile", { file }) };
    }
    case "read_file": {
      const file = basename(args.path);
      return { Icon: FileText, label: t("readFile", { file }), activeLabel: t("readingFile", { file }) };
    }
    case "list_files":
      return { Icon: Folder, label: t("listedFiles"), activeLabel: t("listingFiles") };
    case "search_files": {
      const query = clip(args.pattern, 32);
      return {
        Icon: Search,
        label: query ? t("searchedFor", { query }) : t("searchedFiles"),
        activeLabel: t("searchingFiles"),
      };
    }
    case "execute_bash":
      return { Icon: Terminal, label: t("ranCommand"), activeLabel: t("runningCommand"), detail: clip(args.command) };
    case "execute_python":
      return { Icon: Code, label: t("ranPython"), activeLabel: t("runningPython") };
    case "execute_node":
      return { Icon: Code, label: t("ranJavaScript"), activeLabel: t("runningJavaScript") };
  }

  // Heuristics for MCP / unknown tools so they still read like actions.
  if (/(web|search|google|brave|tavily)/.test(name)) {
    const query = clip(args.query ?? args.q ?? args.pattern, 40);
    return { Icon: Globe, label: query ? t("searchedWebFor", { query }) : t("searchedWeb"), activeLabel: t("searchingWeb") };
  }
  if (/(fetch|http|url|browse|scrape)/.test(name)) {
    return { Icon: Globe, label: t("fetchedPage"), activeLabel: t("fetchingPage") };
  }

  // Unknown tool — its own name is the most useful label (not translatable).
  const pretty = prettyToolName(toolName);
  return { Icon: Wrench, label: pretty || t("usedTool"), activeLabel: pretty ? `${pretty}…` : t("working") };
}
