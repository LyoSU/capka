import Link from "next/link";
import { useTranslations } from "next-intl";

import { ClawMark } from "@/components/brand/claw-mark";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

/**
 * Shown when a chat is shared only to signed-in users and the visitor has no
 * session. A self-contained prompt rather than a redirect — sign-in lands on
 * /chat, so bouncing the visitor there would lose the share link entirely.
 */
export function ShareGate() {
  const t = useTranslations("chat.share");
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <ClawMark className="mb-6 size-12 text-muted-foreground" />
      <h1 className="text-lg font-medium">{t("gateTitle")}</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("gateDescription")}</p>
      <Link href="/login" className={cn(buttonVariants(), "mt-6")}>
        {t("signIn")}
      </Link>
    </div>
  );
}
