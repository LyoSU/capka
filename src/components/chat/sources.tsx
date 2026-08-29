"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Globe } from "lucide-react";
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
function Monogram({ host }: { host: string }) {
  const letter = /\p{L}/u.test(host[0] ?? "") ? host[0] : null;
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-border/70 text-[9px] font-semibold uppercase leading-none text-muted-foreground"
    >
      {letter ?? <Globe className="h-2.5 w-2.5" />}
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

/** How many tiles a long list shows before the rest waits behind "N more". */
const COLLAPSED_TILES = 5;

/** The sources a reply actually cited, as tiles under the answer — only the
 *  cited ones (the full result lists already live in the step panels), in
 *  first-use order, one tile per URL: branch-global numbering can hand the
 *  same page two numbers across searches, and two tiles for one page would
 *  read as two sources. */
export function CitedSourcesFooter({ list }: { list: NumberedSource[] }) {
  const t = useTranslations("chat.citations");
  const [expanded, setExpanded] = useState(false);

  const byUrl = new Map<string, { ns: number[]; source: NumberedSource }>();
  for (const s of list) {
    const g = byUrl.get(s.url);
    if (g) g.ns.push(s.n);
    else byUrl.set(s.url, { ns: [s.n], source: s });
  }
  const tiles = [...byUrl.values()];
  // Collapse only when it saves more than one row's worth — a "1 more" button
  // occupying the slot the tile itself would have used helps nobody.
  const collapsed = !expanded && tiles.length > COLLAPSED_TILES + 1;
  const shown = collapsed ? tiles.slice(0, COLLAPSED_TILES) : tiles;

  return (
    <div className="animate-message-in mt-3 border-t border-border pt-2.5">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("sources")}</div>
      <ul className="grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map(({ ns, source: s }) => {
          const host = hostOf(s.url);
          return (
            <li key={s.url} className="min-w-0">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                title={s.url}
                className="flex h-full flex-col gap-1 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-2 no-underline transition-colors hover:border-primary/40 hover:bg-hover"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
                  {host && <Monogram host={host} />}
                  <span className="truncate">{host ?? s.url}</span>
                  <span className="ml-auto flex shrink-0 gap-1">
                    {ns.map((n) => (
                      <span key={n} className={`${NUMBER_PILL} h-4 min-w-4 bg-background px-1 text-[10px]`}>{n}</span>
                    ))}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs leading-snug text-foreground">{s.title}</span>
              </a>
            </li>
          );
        })}
        {collapsed && (
          <li className="min-w-0">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-hover hover:text-foreground"
            >
              {t("more", { n: tiles.length - COLLAPSED_TILES })}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
