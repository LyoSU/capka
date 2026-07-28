import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Compass, Home } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

/**
 * Root 404. Catches `notFound()` calls and any unmatched URL across the app.
 * Renders inside the root layout, so theme and i18n apply.
 */
export default async function NotFound() {
  const t = await getTranslations("errors.notFound");

  return (
    <EmptyState
      size="page"
      as="h1"
      icon={Compass}
      title={t("title")}
      hint={t("message")}
      className="min-h-[100dvh]"
    >
      <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
        <Home />
        {t("home")}
      </Link>
    </EmptyState>
  );
}
