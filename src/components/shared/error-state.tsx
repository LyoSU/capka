"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, ChevronRight, Home, RotateCw } from "lucide-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  error: Error & { digest?: string };
  /** Re-fetch and re-render the failed segment. From Next's `unstable_retry`. */
  retry?: () => void;
}

/**
 * Full-area, friendly, role-aware error fallback for route-level `error.tsx`
 * boundaries. Everyone sees a calm, non-technical message; admins can expand
 * the raw detail (mirrors the in-chat ErrorNotice). The session lookup fails
 * safe — if the role is unknown, the technical detail stays hidden.
 */
export function ErrorState({ error, retry }: ErrorStateProps) {
  const t = useTranslations("errors.page");
  const tCommon = useTranslations("common");
  const isAdmin = useIsAdmin();

  useEffect(() => {
    console.error(error);
  }, [error]);

  const detail = error.digest
    ? `${error.message}\n\n${t("errorId", { id: error.digest })}`
    : error.message;

  return (
    <div className="flex min-h-[60dvh] w-full flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive-border bg-destructive-surface text-destructive-text">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{t("message")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {retry && (
          <Button onClick={retry}>
            <RotateCw />
            {tCommon("retry")}
          </Button>
        )}
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
          <Home />
          {t("home")}
        </Link>
      </div>
      {isAdmin && detail && (
        <Collapsible className="w-full max-w-md text-left">
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>.chevron]:rotate-90">
            <ChevronRight className="chevron h-3 w-3 transition-transform" />
            {t("technicalDetails")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2.5 font-mono text-[11px] text-muted-foreground">
              {detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
