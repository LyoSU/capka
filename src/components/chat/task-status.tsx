"use client";

import { useEffect, useState } from "react";
import { describeStep } from "./steps";

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return "";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}:${String(remSec).padStart(2, "0")}`;
}

export function TaskStatus({
  startedAt,
  currentTool,
}: {
  startedAt: number;
  currentTool: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const label = currentTool ? describeStep(currentTool).activeLabel : "Thinking…";
  const time = formatElapsed(elapsed);

  return (
    <div className="flex items-center gap-2.5 px-5 py-3 text-sm text-muted-foreground animate-in fade-in duration-300">
      <div className="inline-grid grid-cols-3 gap-[3px]">
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-foreground/40"
            style={{ animation: `dot-chase 1.6s ease-in-out ${[0,1,2,5,8,7,6,3,4][i] * 0.15}s infinite` }}
          />
        ))}
      </div>
      <span>{label}{time ? ` · ${time}` : ""}</span>
    </div>
  );
}
