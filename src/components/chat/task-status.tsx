"use client";

import { useEffect, useState } from "react";
import { Loader2, Wrench, Brain } from "lucide-react";

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

const TOOL_LABELS: Record<string, string> = {
  execute_bash: "Running command",
  file_read: "Reading file",
  file_write: "Writing file",
  file_edit: "Editing file",
  list_directory: "Browsing files",
  web_search: "Searching the web",
  web_browse: "Browsing the web",
};

function getToolLabel(name: string | null): string | null {
  if (!name) return null;
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const clean = name.replace(/^filesystem_/, "").replace(/_/g, " ");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function TaskStatus({
  startedAt,
  currentTool,
  toolCount,
}: {
  startedAt: number;
  currentTool: string | null;
  toolCount: number;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const toolLabel = getToolLabel(currentTool);
  const isThinking = !currentTool;

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
      {isThinking ? (
        <Brain className="h-3.5 w-3.5 animate-pulse" />
      ) : (
        <Wrench className="h-3.5 w-3.5" />
      )}
      <span>
        {isThinking ? "Thinking" : toolLabel}
        {toolCount > 0 && (
          <span className="text-muted-foreground/50"> · {toolCount} step{toolCount !== 1 ? "s" : ""}</span>
        )}
      </span>
      <span className="tabular-nums text-muted-foreground/40">{formatElapsed(elapsed)}</span>
      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/30" />
    </div>
  );
}
