"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Clock } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

/**
 * Landing spot for an account created under the "approval" registration mode.
 * The dashboard layout parks pending users here; once an admin approves them,
 * a fresh sign-in lands in the app. Friendly and jargon-free per the audience.
 */
export default function PendingPage() {
  const router = useRouter();
  const t = useTranslations("auth.pending");

  const signOut = async () => {
    await authClient.signOut();
    router.push("/login");
  };

  return (
    <AuthShell
      title={t("title")}
      description={t("description")}
      footer={
        <button onClick={signOut} className="font-medium text-foreground hover:underline">
          {t("signOut")}
        </button>
      }
    >
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-muted/30 px-6 py-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/40">
          <Clock className="h-6 w-6 text-amber-600 dark:text-amber-500" />
        </div>
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        <Button variant="outline" size="sm" onClick={() => router.refresh()}>
          {t("recheck")}
        </Button>
      </div>
    </AuthShell>
  );
}
