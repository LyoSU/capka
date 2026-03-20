"use client";

import { useEffect, useState } from "react";
import { Brain } from "lucide-react";

interface Memory {
  id: string;
  content: string;
  type: string;
  createdAt: string;
}

export function MemorySummary() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/memories")
      .then((r) => (r.ok ? r.json() : []))
      .then(setMemories)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  const recent = memories.slice(0, 3);

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Memory</span>
        <span className="text-xs text-muted-foreground">
          {memories.length} {memories.length === 1 ? "item" : "items"}
        </span>
      </div>
      {recent.length > 0 ? (
        <ul className="space-y-1">
          {recent.map((m) => (
            <li key={m.id} className="text-xs text-muted-foreground truncate">
              {m.content}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No memories yet.</p>
      )}
    </div>
  );
}
