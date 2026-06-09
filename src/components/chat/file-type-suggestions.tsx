"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileText, Sheet, FileType, Image as ImageIcon, type LucideIcon } from "lucide-react";

// Curated, file-centric starting points. Each action fills the composer with a
// scaffold the user finishes (usually by attaching the file), reflecting the
// "drop a file in, get work back" model. Switching type swaps the action set.
const CATALOG: Record<string, { icon: LucideIcon; actions: string[] }> = {
  pdf: { icon: FileText, actions: ["extractText", "fillForm", "toWord"] },
  spreadsheet: { icon: Sheet, actions: ["analyze", "chart", "clean"] },
  document: { icon: FileType, actions: ["summarize", "translate", "reformat"] },
  image: { icon: ImageIcon, actions: ["ocr", "removeBg", "resize"] },
};
const TYPES = Object.keys(CATALOG);

export function FileTypeSuggestions({ onPick }: { onPick: (text: string) => void }) {
  const t = useTranslations("chat.panel.getToWork");
  const [type, setType] = useState<string>("pdf");
  const { icon: Icon, actions } = CATALOG[type];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("header")}</span>
        {TYPES.map((ty) => (
          <button
            key={ty}
            type="button"
            onClick={() => setType(ty)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              ty === type
                ? "border-foreground/20 bg-muted text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60"
            }`}
          >
            {t(`types.${ty}`)}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border">
        {actions.map((a, i) => (
          <button
            key={a}
            type="button"
            onClick={() => onPick(t(`${type}.${a}.prompt`))}
            className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted/60 ${
              i > 0 ? "border-t" : ""
            }`}
          >
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            {t(`${type}.${a}.label`)}
          </button>
        ))}
      </div>
    </div>
  );
}
