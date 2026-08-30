"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MemoryReview } from "@/components/settings/memory-review";
import { MemoryFacts } from "@/components/settings/memory-topics";
import {
  SettingsEmpty,
  SettingsError,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSkeleton,
} from "@/components/settings/shell";
import { parseAgentProfile, type AgentProfile } from "@/lib/agents/profile";
import type { ScopeView } from "@/lib/vault/memory-page";

/**
 * What the assistant remembers, as facts rather than as a document.
 *
 * This replaces a disabled monospace textarea holding one markdown string. That shape
 * could not carry the three relations the vault already records — which topic a fact is
 * filed under, which conversation it came from, and what it replaced — so the page threw
 * all three away, and had nowhere at all to put the facts still waiting for the reader's
 * decision. `readMemoryPage` assembles them server-side; this file is a renderer.
 *
 * Still absent, and by task rather than by oversight: the sensitive-consent switch (Task 4).
 *
 * THE FACTS ARE ONE LIST, not a topic rail — see `MemoryFacts` for what the rail was
 * hiding. The search box that replaces it is SERVER-SIDE, because the list it filters is
 * capped: filtering in the browser could only ever search the rows the server chose to
 * send, which is the search failing precisely on the memory large enough to need one.
 *
 * HOW A FACT GETS SAVED is stated on the page, and there is deliberately no "add fact"
 * control to state it with. A hand-typed fact has no honest provenance, and provenance
 * is the whole reason the vault exists — so the sentence IS the affordance. The live
 * data is what made this worth a line: of 31 candidates, 30 arrived from the post-turn
 * extraction (which files them as waiting, by design) and exactly one from a person
 * saying "remember that…" out loud. The mechanism works; nothing on either surface said
 * so, and the maintainer read that silence as a broken page.
 */

/** One scope's contents. The user's own memory is unheaded — it is what the page is
 *  about — while a project's is a titled section, because "which project" is the thing
 *  the reader needs to know before reading a single fact under it. */
function Scope({ scope, onChanged }: { scope: ScopeView; onChanged: () => void }) {
  const body = (
    <>
      <MemoryFacts facts={scope.facts} matched={scope.factsMatched} onChanged={onChanged} />
      <MemoryReview pending={scope.pending} onChanged={onChanged} />
    </>
  );
  if (scope.scope === "user") return <div className="space-y-10">{body}</div>;
  return (
    <SettingsSection title={scope.projectName ?? ""}>
      <div className="space-y-10">{body}</div>
    </SettingsSection>
  );
}

/**
 * "Forget everything" — the most destructive control on this page, and the one with no
 * narrower alternative behind it.
 *
 * CONFIRMED, and with a DIFFERENT dialog from the per-fact delete rather than a reuse of
 * it. That one deliberately names nothing about the row it removes, so that a sensitive
 * fact needs no second, emptier variant. Here the opposite obligation applies: the promise
 * being made is "everything", and a person cannot check a promise of that size against a
 * dialog that names nothing. So this one carries the COUNT — a number withholds exactly as
 * much as that dialog does, since it is not the fact's text — and it says what SURVIVES,
 * because a dialog claiming "everything" while chats and files quietly stay is a claim the
 * reader has no way to test.
 *
 * NOT type-to-confirm, which was the other real option. It is a developer-tool ritual: it
 * asks a non-technical office user to transcribe a token, in a UI whose first language is
 * Ukrainian, and it defends against one mis-click by making every deliberate use tedious.
 * The weight is carried instead by where the control sits (its own section at the foot of
 * the page, with nothing else near it to mis-hit), by its being a quiet tinted button
 * rather than a filled one, and by the dialog stating the size of what goes.
 *
 * It renders only when there IS something to forget. A destructive control that would do
 * nothing is still a thing a person has to read and decide to ignore.
 *
 * The count is of FACTS only, matching the two headings above it; the route also ends
 * every unverified head, which this page has never shown and the copy therefore does not
 * promise. What the copy does promise — the waiting list going too — is the one part a
 * reader can see disappear.
 */
function ForgetEverything({ facts, onChanged }: { facts: number; onChanged: () => void }) {
  const t = useTranslations("settings.memory");
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const forgetAll = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success(t("resetDone"));
      // Re-read rather than emptying the local state: whether a scope disappears entirely
      // is the server's decision, and after this it is the only interesting one left.
      onChanged();
    } catch {
      toast.error(t("resetFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t("resetTitle")} description={t("resetHint")}>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogTrigger render={<Button variant="destructive" disabled={busy}>{t("reset")}</Button>} />
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resetConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>{t("resetConfirmBody", { facts })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={forgetAll}>{t("reset")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

export default function MemoryPage() {
  const t = useTranslations("settings.memory");
  const [scopes, setScopes] = useState<ScopeView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The user's own memory switch, plus the org ceiling that can override it. What is
  // recorded below stays VISIBLE either way: turning memory off leaves saved facts
  // alone, merely unused, so hiding them would suggest they were lost.
  // Held as a whole profile because that's what GET returns, but only the memory
  // bit is ever POSTed: the endpoint merges the patch over the stored row, so it —
  // not every caller — is what keeps the other fields from being reset by schema
  // defaults. It also refuses to write them at all (see api/me/agent-profile).
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [lockedOff, setLockedOff] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/me/agent-profile", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setProfile(parseAgentProfile(d.profile));
        setLockedOff(d.ceiling?.capabilities?.memory === false);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const toggleMemory = (checked: boolean) => {
    if (!profile) return;
    const prev = profile;
    const next: AgentProfile = { ...profile, capabilities: { ...profile.capabilities, memory: checked } };
    setProfile(next);
    fetch("/api/me/agent-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: { memory: checked } }),
    })
      .then((r) => {
        if (!r.ok) {
          setProfile(prev);
          toast.error(t("saveFailed"));
        }
      })
      .catch(() => {
        setProfile(prev);
        toast.error(t("saveFailed"));
      });
  };

  // The search, in two pieces: what the box shows, and what has actually been asked for.
  // The box has to stay responsive to every keystroke while the request is not sent on
  // every keystroke, and a `query`-shaped `useEffect` dependency is what makes the
  // debounce a property of the data flow rather than a timer somebody has to remember to
  // clear. Trailing edge, so the last thing typed is the thing searched for.
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setAsked(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  // `load` has more than one caller — the debounced search effect below, and every
  // `onChanged` a child fires after a delete or a confirm — so a sequence token has to
  // live outside any one of them. The ref holds whichever request is currently allowed to
  // win: starting a new one aborts whatever it is still holding, so a search fired while an
  // older one is in flight (or an edit's `onChanged` racing a debounced search) can no
  // longer have the older response land second and overwrite the newer one. Aborting also
  // turns a failing STALE request into a no-op instead of a false "load failed" panel that
  // replaces the whole page, including the search box, after a newer request already
  // succeeded.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    try {
      setError("");
      const res = await fetch(`/api/memory?q=${encodeURIComponent(asked)}`, { signal: ac.signal });
      if (!res.ok) throw new Error();
      const data: { scopes: ScopeView[] } = await res.json();
      setScopes(data.scopes ?? []);
    } catch {
      // Aborted means a newer `load` superseded this one — not a failure, and the newer
      // call already owns `error`/`loading`. Only a request still current gets to report.
      if (ac.signal.aborted) return;
      // A panel, not a toast: a page that failed to load has to keep saying so.
      setError(t("loadError"));
    } finally {
      if (inFlight.current === ac) setLoading(false);
    }
  }, [t, asked]);

  useEffect(() => {
    load();
    return () => inFlight.current?.abort();
  }, [load]);

  if (loading) return <SettingsSkeleton rows={1} />;

  // "Nothing here" and "nothing matched" are different sentences and must not be shared:
  // an empty search result that read "Nothing remembered yet" would tell a person their
  // memory is gone. `factsTotal` is the query-independent count, so it stays true while
  // the search box has words in it.
  const empty = !!scopes && scopes.every((s) => !s.factsTotal && !s.pending.length);
  const nothingYet = empty && !asked;
  const noMatches = !!scopes && !!asked && scopes.every((s) => !s.factsMatched);
  // Shown once there is anything to search — and kept on screen while the box has words in
  // it, or a search that matched nothing would remove the control needed to undo it.
  const searchable = !!scopes && (!!query || scopes.some((s) => s.factsTotal));

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      <SettingsGroup>
        <SettingsRow
          id="memory-enabled"
          title={t("enabled")}
          hint={lockedOff ? t("enabledLocked") : t("enabledHint")}
          disabled={lockedOff}
          onLabelClick={() => toggleMemory(!profile?.capabilities.memory)}
          control={
            <Switch
              checked={!!profile?.capabilities.memory && !lockedOff}
              disabled={lockedOff || profile === null}
              onCheckedChange={toggleMemory}
            />
          }
        />
      </SettingsGroup>

      {error ? (
        <SettingsError message={error} />
      ) : nothingYet ? (
        <SettingsEmpty title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <>
          {/* Said once, above everything, rather than per section: it is the answer to
              "what do I do here", and the reader asks that before they read a fact. */}
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{t("howToSave")}</p>

          {searchable && (
            <div className="space-y-2">
              <div className="relative max-w-xs">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                {/* `type="search"` for the browser's own clear affordance — a person who
                    typed a word that matched nothing needs the way back to be obvious. */}
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                  aria-label={t("searchPlaceholder")}
                  className="h-9 pl-8"
                />
              </div>
              {/* The honest sentence about what this list is. It sits UNDER the box rather
                  than at the top of the page because it answers the question the box
                  prompts — "can I organise these?" — and it promises no date. */}
              <p className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">{t("noGrouping")}</p>
            </div>
          )}

          {noMatches && (
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{t("searchEmpty")}</p>
          )}

          {scopes?.map((scope) => (
            <Scope key={scope.projectId ?? "user"} scope={scope} onChanged={load} />
          ))}
          {/* Last on the page, after everything it would destroy: a reset offered before
              the reader has seen what they have is a question asked too early.
              `factsTotal`, never the matched count: the dialog promises "everything", and a
              number the search box narrowed would understate what the button does. */}
          <ForgetEverything
            facts={scopes?.reduce((n, s) => n + s.factsTotal, 0) ?? 0}
            onChanged={load}
          />
        </>
      )}
    </SettingsPage>
  );
}
