import type { ComponentType } from "react";
import {
  FilePlus, FilePen, FileText, Folder, Search, Terminal, Code, Globe, Wrench,
} from "lucide-react";

export type StepIcon = ComponentType<{ className?: string }>;

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
export function describeStep(toolName: string, input?: unknown): StepDescriptor {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = toolName.toLowerCase();

  switch (name) {
    case "write_file": {
      const f = basename(args.path);
      return { Icon: FilePlus, label: `Created ${f}`, activeLabel: `Creating ${f}…` };
    }
    case "str_replace": {
      const f = basename(args.path);
      return { Icon: FilePen, label: `Edited ${f}`, activeLabel: `Editing ${f}…` };
    }
    case "read_file": {
      const f = basename(args.path);
      return { Icon: FileText, label: `Read ${f}`, activeLabel: `Reading ${f}…` };
    }
    case "list_files":
      return { Icon: Folder, label: "Listed files", activeLabel: "Looking through files…" };
    case "search_files": {
      const q = clip(args.pattern, 32);
      return {
        Icon: Search,
        label: q ? `Searched for “${q}”` : "Searched files",
        activeLabel: "Searching files…",
      };
    }
    case "execute_bash":
      return { Icon: Terminal, label: "Ran a command", activeLabel: "Running a command…", detail: clip(args.command) };
    case "execute_python":
      return { Icon: Code, label: "Ran Python", activeLabel: "Running Python…" };
    case "execute_node":
      return { Icon: Code, label: "Ran JavaScript", activeLabel: "Running JavaScript…" };
  }

  // Heuristics for MCP / unknown tools so they still read like actions.
  if (/(web|search|google|brave|tavily)/.test(name)) {
    const q = clip(args.query ?? args.q ?? args.pattern, 40);
    return { Icon: Globe, label: q ? `Searched the web for “${q}”` : "Searched the web", activeLabel: "Searching the web…" };
  }
  if (/(fetch|http|url|browse|scrape)/.test(name)) {
    return { Icon: Globe, label: "Fetched a page", activeLabel: "Fetching a page…" };
  }

  const pretty = prettyToolName(toolName);
  return { Icon: Wrench, label: pretty || "Used a tool", activeLabel: `${pretty || "Working"}…` };
}
