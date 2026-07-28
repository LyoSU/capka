"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Clock, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
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

  // A bare `router.refresh()` re-rendered this page identically, so someone
  // waiting on approval could not tell the button from a broken one. The
  // transition gives it a pending state, and the "still waiting" line is the
  // answer to the question they actually asked. Approval unmounts this page, so
  // the message only ever appears when nothing has changed.
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
          <Clock className="h-6 w-6 text-warning-text" />
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
