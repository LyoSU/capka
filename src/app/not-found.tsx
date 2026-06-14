import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Compass, Home } from "lucide-react";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

/**
 * Root 404. Catches `notFound()` calls and any unmatched URL across the app.
 * Renders inside the root layout, so theme and i18n apply.
 */
export default async function NotFound() {
  const t = await getTranslations("errors.notFound");

  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Compass className="h-6 w-6" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{t("message")}</p>
      </div>
      <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
        <Home />
        {t("home")}
      </Link>
    </div>
  );
}
