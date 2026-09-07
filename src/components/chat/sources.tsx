"use client";

import { useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { Globe, ChevronDown } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { NumberedSource } from "@/lib/mcp/search-normalize";

export function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A quiet letter mark standing in for a favicon — deliberately NOT a favicon
 *  fetch: pulling icons from every cited site would leak what the user read to
 *  third parties, which a self-hosted product exists to avoid. A host whose
 *  first character carries no meaning as a letter (an IP, punycode) falls back
 *  to a neutral globe. */
function Monogram({ host, className = "" }: { host: string; className?: string }) {
  const letter = /\p{L}/u.test(host[0] ?? "") ? host[0] : null;
  return (
    <span
      aria-hidden
      className={`flex size-4 shrink-0 items-center justify-center rounded-full bg-border/70 text-[10px] font-semibold uppercase leading-none text-muted-foreground ${className}`}
    >
      {letter ?? <Globe className="size-2.5" />}
    </span>
  );
}

/** The number badge shared by the inline chip and the footer tile (sizes differ,
 *  surface language matches), so a [N] in the text and its tile read as the
 *  same object. */
const NUMBER_PILL =
  "inline-flex items-center justify-center rounded-full bg-muted font-medium leading-none tabular-nums text-muted-foreground ring-1 ring-inset ring-border/60";

/**
 * Inline citation: the `[N]` a reply resolved against its search sources,
 * rendered as a small raised pill that opens the source. A real component (not
 * CSS over the markdown anchor) because Streamdown sanitizes the hast with
 * rehype-sanitize's default schema, which strips the `data-citation` attribute
 * an attribute selector would need. Hover/keyboard-focus shows the source card;
 * click and touch navigate immediately — one behavior per gesture, no two-tap
 * link. The `citation-chip` class opts the anchor out of the prose link color,
 * hover underline, and the print URL-append (globals.css).
 */
export function CitationChip({ n, source }: { n: number; source: NumberedSource }) {
  const t = useTranslations("chat.citations");
  const host = hostOf(source.url);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={t("openSource", { n, title: source.title })}
            // Raised into the superscript band but kept in the line (a true
            // `super` detaches the pill from the punctuation after it); the
            // side margins are what keep a [1, 9] group two distinct pills.
            className={`${NUMBER_PILL} citation-chip mx-[0.15em] h-[1.125rem] min-w-[1.125rem] cursor-pointer px-[5px] text-[11px] align-[0.18em] no-underline transition-colors hover:bg-primary hover:text-primary-foreground hover:ring-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring`}
          >
            {n}
          </a>
        }
      />
      <TooltipContent className="flex max-w-64 flex-col items-start gap-1 px-3 py-2">
        <span className="line-clamp-2 text-left font-medium">{source.title}</span>
        <span className="flex items-center gap-1 text-[11px] text-background/70">
          {host}
          {source.date && <span>· {source.date}</span>}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** How many marks the closed row stacks before the count carries the rest. */
const STACKED_MARKS = 4;

/** The sources a reply actually cited, under the answer: a stack of their marks
 *  and a count that opens the full list. Closed by default — the [N] chips in the
 *  text already open each source where it is used, so the list is for the reader
 *  who wants the whole set at once, not a second grid competing with the answer.
 *  Only the cited ones (the full result lists already live in the step panels),
 *  in first-use order, one row per URL: branch-global numbering can hand the same
 *  page two numbers across searches, and two rows for one page would read as two
 *  sources. */
export function CitedSourcesFooter({ list }: { list: NumberedSource[] }) {
  const t = useTranslations("chat.citations");
  const [open, setOpen] = useState(false);

  const byUrl = new Map<string, { ns: number[]; source: NumberedSource }>();
  for (const s of list) {
    const g = byUrl.get(s.url);
    if (g) g.ns.push(s.n);
    else byUrl.set(s.url, { ns: [s.n], source: s });
  }
  const rows = [...byUrl.values()];

  return (
    <div className="animate-message-in mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-micro hover:bg-hover hover:text-foreground"
      >
        <span className="flex -space-x-1">
          {rows.slice(0, STACKED_MARKS).map(({ source: s }) => (
            // The ring is the page colour, so overlapping marks read as a stack of
            // discs rather than one blob.
            <Monogram key={s.url} host={hostOf(s.url) ?? ""} className="ring-2 ring-background" />
          ))}
        </span>
        <span>{t("count", { n: rows.length })}</span>
        <ChevronDown
          className="size-3 transition-transform duration-300 [transition-timing-function:var(--ease-strong)]"
          style={{ transform: open ? "rotate(180deg)" : undefined }}
          aria-hidden="true"
        />
      </button>

      {/* Opens by growing out of the row (0fr → 1fr) instead of appearing, the same
          grammar as every spoiler here; no height is measured. `inert` keeps the
          closed list's links out of the tab order and off the accessibility tree. */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 [transition-timing-function:var(--ease-strong)]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden" inert={!open}>
          <ul className="mt-1.5 flex list-none flex-col gap-px rounded-lg bg-muted/40 p-1 shadow-hairline">
            {rows.map(({ ns, source: s }, i) => {
              const host = hostOf(s.url);
              return (
                // The class is applied only while open, so the rows cascade in on
                // every opening rather than once on mount behind a closed lid.
                <li key={s.url} className={`min-w-0 ${open ? "animate-fade-up" : ""}`} style={{ "--i": i } as CSSProperties}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    title={s.url}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs no-underline transition-micro hover:bg-hover"
                  >
                    <Monogram host={host ?? ""} />
                    <span className="min-w-0 flex-1 truncate text-foreground">{s.title}</span>
                    <span className="flex shrink-0 gap-1">
                      {ns.map((n) => (
                        <span key={n} className={`${NUMBER_PILL} h-4 min-w-4 bg-background px-1 text-[10px]`}>{n}</span>
                      ))}
                    </span>
                    <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">{host ?? s.url}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
