"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ban } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

/**
 * Landing spot for an account an admin has suspended. The dashboard layout parks
 * suspended users here; if the admin reactivates them, a refresh (or fresh
 * sign-in) lands them back in the app. Calm and jargon-free per the audience:
 * no error code, just what happened and who to ask.
 */
export default function SuspendedPage() {
  const router = useRouter();
  const t = useTranslations("auth.suspended");

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
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-warning-border bg-warning-surface">
          <Ban className="h-6 w-6 text-warning-text" />
        </div>
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        <Button variant="outline" size="sm" onClick={() => router.refresh()}>
          {t("recheck")}
        </Button>
      </div>
    </AuthShell>
  );
}
