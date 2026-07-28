"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ban, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
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

  // Same reason as the pending screen: the refresh used to produce an identical
  // page, which reads as a dead button to someone waiting to be let back in.
  const [checking, startCheck] = useTransition();
  const asked = useRef(false);

  useEffect(() => {
    if (checking || !asked.current) return;
    asked.current = false;
    toast.info(t("stillWaiting"));
  }, [checking, t]);

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
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => {
            asked.current = true;
            startCheck(() => router.refresh());
          }}
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
          {t("recheck")}
        </Button>
      </div>
    </AuthShell>
  );
}
