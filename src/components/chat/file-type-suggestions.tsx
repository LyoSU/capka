"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  FileText, Sheet, FileType, Image as ImageIcon,
  ScanText, FormInput, FileType2, ChartBar, Sparkles, ScrollText,
  Languages, AlignLeft, ScanLine, Eraser, Crop, ArrowRight,
  type LucideIcon,
} from "lucide-react";

// Curated, file-centric starting points. Each action fills the composer with a
// scaffold the user finishes (usually by attaching the file), reflecting the
// "drop a file in, get work back" model. Switching type swaps the action set.
// Each action carries its own glyph so the list reads as distinct verbs, not a
// column of the same file icon.
const CATALOG: Record<string, { icon: LucideIcon; actions: { key: string; icon: LucideIcon }[] }> = {
  pdf: { icon: FileText, actions: [
    { key: "extractText", icon: ScanText },
    { key: "fillForm", icon: FormInput },
    { key: "toWord", icon: FileType2 },
  ] },
  spreadsheet: { icon: Sheet, actions: [
    { key: "analyze", icon: ChartBar },
    { key: "chart", icon: Sparkles },
    { key: "clean", icon: Eraser },
  ] },
  document: { icon: FileType, actions: [
    { key: "summarize", icon: ScrollText },
    { key: "translate", icon: Languages },
    { key: "reformat", icon: AlignLeft },
  ] },
  image: { icon: ImageIcon, actions: [
    { key: "ocr", icon: ScanLine },
    { key: "removeBg", icon: Eraser },
    { key: "resize", icon: Crop },
  ] },
};
const TYPES = Object.keys(CATALOG);

export function FileTypeSuggestions({ onPick }: { onPick: (text: string) => void }) {
  const t = useTranslations("chat.panel.getToWork");
  const [type, setType] = useState<string>("pdf");
  const { actions } = CATALOG[type];

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

      {/* key={type} remounts the list when the type changes, so the rows
          re-run their staggered entrance — switching tabs feels alive. */}
      <div key={type} className="overflow-hidden rounded-xl border">
        {actions.map(({ key: a, icon: ActionIcon }, i) => (
          <button
            key={a}
            type="button"
            onClick={() => onPick(t(`${type}.${a}.prompt`))}
            style={{ animationDelay: `${i * 55}ms` }}
            className={`group/sg animate-step-in flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted/60 ${
              i > 0 ? "border-t" : ""
            }`}
          >
            <ActionIcon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover/sg:text-foreground" />
            <span className="flex-1">{t(`${type}.${a}.label`)}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover/sg:translate-x-0 group-hover/sg:opacity-100" />
          </button>
        ))}
      </div>
    </div>
  );
}
