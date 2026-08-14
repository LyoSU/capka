"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PluginReviewPanel, type PluginReview, type PolicyOutlook } from "@/components/settings/plugin-review";

/**
 * The consent screen for a FIRST install, driven by `GET`/`POST /api/extensions/review`.
 *
 * Shared by the admin catalog and the member browser rather than copied into each. They differ
 * only in the scope they ask for, and the thing that made this gate optional the first time was
 * exactly a second caller reaching the same rows by its own route: the API moved behind the
 * review while both Install buttons still posted to the endpoints it replaced, so first-install
 * returned 410 from both screens.
 *
 * The dialog owns the whole round trip — build the review, show it, post it back with the hash
 * it carries — so neither browser can install without one, and neither can drift from the
 * other in how it asks.
 */

export interface InstallTargetRef {
  marketplaceId: string;
  pluginName: string;
}

interface ReviewPayload {
  review: PluginReview;
  policies: PolicyOutlook[];
  targetSha: string;
}

export function PluginInstallDialog({ target, scope, onInstalled, onClose }: {
  /** Non-null opens the dialog and starts building the review for that plugin. */
  target: InstallTargetRef | null;
  /** `system` for the admin catalog, `user` for a member installing for themselves. The
   *  server checks this again — a member asking for `system` is refused there, not here. */
  scope: "system" | "user";
  onInstalled: () => void | Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations("settings.marketplace");
  const tReview = useTranslations("settings.skills.installed.review");
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [dispositions, setDispositions] = useState<Record<string, "keep" | "delete">>({});
  const [applying, setApplying] = useState(false);

  // Rebuilt from scratch for each target: a review is bound to a commit, a baseline and a set
  // of live observations, so there is nothing here worth carrying between two plugins.
  useEffect(() => {
    if (!target) { setPayload(null); setDispositions({}); return; }
    let live = true;
    setPayload(null);
    setDispositions({});
    (async () => {
      try {
        const qs = new URLSearchParams({
          marketplaceId: target.marketplaceId, pluginName: target.pluginName, scope,
        });
        const r = await fetch(`/api/extensions/review?${qs}`);
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { toast.error(d.error ?? t("installFailed")); onClose(); return; }
        setPayload(d as ReviewPayload);
      } catch {
        if (live) { toast.error(t("installFailed")); onClose(); }
      }
    })();
    return () => { live = false; };
  }, [target, scope, t, onClose]);

  const apply = useCallback(async () => {
    if (!target || !payload) return;
    setApplying(true);
    try {
      const r = await fetch("/api/extensions/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketplaceId: target.marketplaceId, pluginName: target.pluginName, scope,
          targetSha: payload.targetSha, reviewHash: payload.review.reviewHash, dispositions,
        }),
      });
      if (r.ok) {
        toast.success(t("installed", {
          skills: payload.review.surface.skills.length,
          connectors: payload.review.surface.connectors.length,
        }));
        for (const note of payload.review.notes) toast.message(note);
        onClose();
        await onInstalled();
        return;
      }
      const d = await r.json().catch(() => ({})) as { error?: string; review?: PluginReview; policies?: PolicyOutlook[] };
      if (r.status === 409 && d.review) {
        // Something moved while the operator was reading. Re-present the FRESH review the
        // server already sent, in place — asking for it again would only widen the same window.
        toast.error(tReview(d.error === "blocked" ? "cannotApply" : "staleTitle"));
        setPayload({ review: d.review, policies: d.policies ?? [], targetSha: payload.targetSha });
        return;
      }
      toast.error(d.error === "failed" ? tReview("applyFailed") : t("installFailed"));
      onClose();
    } catch {
      toast.error(t("installFailed"));
      onClose();
    } finally {
      setApplying(false);
    }
  }, [target, payload, scope, dispositions, t, tReview, onInstalled, onClose]);

  return (
    <AlertDialog open={!!target} onOpenChange={(o) => { if (!o && !applying) onClose(); }}>
      <AlertDialogContent>
        {target && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("reviewTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("reviewDesc", { name: target.pluginName })}</AlertDialogDescription>
            </AlertDialogHeader>
            {payload ? (
              <PluginReviewPanel
                review={payload.review}
                policies={payload.policies}
                dispositions={dispositions}
                onDisposition={(key, value) => setDispositions((d) => ({ ...d, [key]: value }))}
              />
            ) : (
              <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />{t("reviewLoading")}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={applying}>{t("cancel")}</AlertDialogCancel>
              {/* Disabled until the review is in hand AND applicable. Consent means having seen
                  what the install reaches, so an Install that can fire before the panel renders
                  is not a gate at all — which is the shape the upgrade dialog had. */}
              <AlertDialogAction
                disabled={!payload || payload.review.gate === "cannot_apply" || applying}
                onClick={(e) => { e.preventDefault(); void apply(); }}
              >
                {applying ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                {t("install")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
