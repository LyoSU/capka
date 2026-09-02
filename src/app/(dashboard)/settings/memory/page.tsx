"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MemoryArchive, MemoryConflicts } from "@/components/settings/memory-review";
import { MemoryTopicDetail, MemoryTopicList, MemoryUnfiled, TopicRows } from "@/components/settings/memory-topics";
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
import type { ScopeView, TopicView } from "@/lib/vault/memory-page";

/**
 * WHAT THE ASSISTANT REMEMBERS, as a list of short topic files.
 *
 * THREE SHAPES IN THREE RELEASES, and the last two are worth one paragraph each because
 * both were deleted deliberately. First a disabled monospace textarea holding one markdown
 * string, which could carry none of the relations the vault already records. Then a flat
 * list of every fact in the space, newest first, with a server-side search box over it —
 * which fixed the real bug it was built for (a topic rail was hiding 18 of this account's
 * 51 facts) and left a page nobody can navigate: fifty one-line sentences in date order,
 * findable only by remembering the words they were saved in.
 *
 * NOW THE UNIT IS A FILE. One per subject, grouped under four headings, each opening to its
 * own text — the shape the reference (claude.ai's Memory settings) arrived at, and the shape
 * a person can actually read. The facts did not go anywhere: they are a collapsed
 * `Related facts` list inside the file they are filed under, which is what keeps §11.9 true
 * — every fact the agent writes stays visible, tagged with where it came from, and
 * deletable one at a time. A fact filed under nothing has its own list at the bottom, so
 * that guarantee is a property of the page and not of which writer happened to run.
 *
 * THE SEARCH BOX WENT WITH THE FLAT LIST. It answered "which of these fifty sentences is
 * the one", a question four headings over five files does not ask — and the sentence under
 * it promised that grouping by subject "isn't available yet", which the sections make false
 * on the same screen.
 *
 * THIS PAGE DOES NOT WRITE MEMORY IN WORDS, and it is worth stating because a draft of it
 * did. A composer here — "tell the assistant what to change or remove", handing the request
 * to a hidden chat running the seven `memory_*` tools — was built and then removed on the
 * maintainer's call: changing memory in words already works in an ordinary chat, where the
 * same tools live and where the person can see what the assistant did and say more, so a
 * second entrance is a second thing to keep correct for no new capability. What the owner
 * does HERE is what only they can do: open a file, read it, delete it, delete one fact
 * under it, or forget everything.
 *
 * THERE IS NO CONFIRMATION STEP. Every fact and every file the assistant saves is live from
 * the moment it is written; what tells a person's own statement apart from the assistant's
 * guess is the TRUST TAG, not a queue in front of it. Two sections carry what is left of a
 * decision: `MemoryConflicts`, where two live facts disagree and one tap settles it, and
 * `MemoryArchive`, the leftovers of the retired review queue, which expires with its table
 * thirty days after this release.
 *
 * Still absent, and by task rather than by oversight: the sensitive-consent switch (Task 4).
 */

/** THE PERSON'S OWN MEMORY: unheaded, because it is what the page is about, and grouped
 *  under the four section headings.
 *
 *  Conflicts FIRST: they are the only thing here that is waiting on the reader, and both of
 *  their halves are also filed under a topic below — a question printed under its own
 *  answers is one nobody reaches. */
function OwnMemory({ scope, archiveExpiresAt, onOpen, onChanged }: {
  scope: ScopeView;
  archiveExpiresAt: string;
  onOpen: (topicId: string) => void;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-10">
      <MemoryConflicts conflicts={scope.conflicts} onChanged={onChanged} />
      <MemoryTopicList topics={scope.topics} onOpen={onOpen} />
      <MemoryUnfiled facts={scope.unfiled} total={scope.unfiledTotal} onChanged={onChanged} />
      <MemoryArchive archive={scope.archive} expiresAt={archiveExpiresAt} onChanged={onChanged} />
    </div>
  );
}

/**
 * PROJECT MEMORY — under one `Projects` heading, one sub-group per project, and NOT a page
 * of its own.
 *
 * A separate page was the other option and it is the wrong one for this audience: a person
 * asking "what does it remember about me" is asking one question, and answering it across
 * two screens means the answer is only ever half visible. What a project needs is a label
 * saying which project, which is what the sub-group heading is.
 *
 * A project's files are ONE list with no section headings — see `TopicRows`. Its conflicts
 * and its archive travel with it, because both are decisions scoped to that project and a
 * decision filed under the wrong scope is one a person answers about the wrong data.
 */
function ProjectMemory({ scopes, archiveExpiresAt, onOpen, onChanged }: {
  scopes: ScopeView[];
  archiveExpiresAt: string;
  onOpen: (topicId: string) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("settings.memory");
  if (!scopes.length) return null;
  return (
    <SettingsSection title={t("sectionProjects")}>
      <div className="space-y-8">
        {scopes.map((scope) => (
          <div key={scope.projectId} className="space-y-4">
            {/* One level below a section title, and above rows that share its size: the
                project's name is a label over a list, not a heading competing with
                "Projects" above it. */}
            <h4 className="text-[13px] font-medium text-muted-foreground">{scope.projectName}</h4>
            <MemoryConflicts conflicts={scope.conflicts} onChanged={onChanged} />
            <TopicRows topics={scope.topics} onOpen={onOpen} />
            <MemoryUnfiled facts={scope.unfiled} total={scope.unfiledTotal} onChanged={onChanged} />
            <MemoryArchive archive={scope.archive} expiresAt={archiveExpiresAt} onChanged={onChanged} />
          </div>
        ))}
      </div>
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
  // The archive's own deadline, as the server computed it. Held beside the scopes rather
  // than derived here: it is one date for the whole page, and a client that computed it
  // would be a second answer to "when does this go".
  const [archiveExpiresAt, setArchiveExpiresAt] = useState("");
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

  // `load` has more than one caller — the mount effect, and every `onChanged` a child
  // fires after a delete, an undo or a confirm — so a sequence token has to live outside
  // any one of them. A delete and its Undo are two of those calls in quick succession,
  // which is the pair that makes the order matter. The ref holds whichever request is
  // currently allowed to win: starting a new one aborts whatever it is still holding, so a
  // re-read fired while an older one is in flight can no longer have the older response
  // land second and overwrite the newer one. Aborting also turns a failing STALE request
  // into a no-op instead of a false "load failed" panel that replaces the whole page after
  // a newer request already succeeded.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    try {
      setError("");
      const res = await fetch("/api/memory", { signal: ac.signal });
      if (!res.ok) throw new Error();
      const data: { scopes: ScopeView[]; archiveExpiresAt: string } = await res.json();
      setScopes(data.scopes ?? []);
      setArchiveExpiresAt(data.archiveExpiresAt ?? "");
    } catch {
      // Aborted means a newer `load` superseded this one — not a failure, and the newer
      // call already owns `error`/`loading`. Only a request still current gets to report.
      if (ac.signal.aborted) return;
      // A panel, not a toast: a page that failed to load has to keep saying so.
      setError(t("loadError"));
    } finally {
      if (inFlight.current === ac) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    return () => inFlight.current?.abort();
  }, [load]);

  // WHICH FILE IS OPEN, by note id, and it survives a re-read: a per-fact delete inside
  // the open file re-reads the whole page, so a state keyed on the object rather than the
  // id would close the detail view every time the list refreshed. A file that was deleted
  // between two reads resolves to `undefined` and the list comes back, which is the right
  // answer — the thing being viewed is gone.
  const [openId, setOpenId] = useState<string | null>(null);

  if (loading) return <SettingsSkeleton rows={1} />;

  const own = scopes?.find((s) => s.scope === "user");
  const projects = scopes?.filter((s) => s.scope === "project") ?? [];
  const allTopics: TopicView[] = scopes?.flatMap((s) => s.topics) ?? [];
  const open = openId ? allTopics.find((x) => x.id === openId) : undefined;

  // NOTHING SAVED YET, and it is the query-independent counts that decide it: a file, a
  // fact, a disagreement or a leftover suggestion all count as something to show.
  const nothingYet =
    !!scopes &&
    scopes.every((s) => !s.topics.length && !s.factsTotal && !s.archive.length && !s.conflicts.length);
  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      {/* THE SWITCH IS HIDDEN WHILE A FILE IS OPEN, along with everything else on the page.
          The detail view is a place, not a panel: the reference gives it the whole column
          with one way back, and a settings row left visible above it would read as a
          setting belonging to the file. */}
      {!open && (
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
      )}

      {error ? (
        <SettingsError message={error} />
      ) : open ? (
        <MemoryTopicDetail topic={open} onBack={() => setOpenId(null)} onChanged={load} />
      ) : nothingYet ? (
        <SettingsEmpty title={t("emptyTitle")} hint={t("empty")} />
      ) : (
        <>
          {own && (
            <OwnMemory
              scope={own}
              archiveExpiresAt={archiveExpiresAt}
              onOpen={setOpenId}
              onChanged={load}
            />
          )}
          <ProjectMemory
            scopes={projects}
            archiveExpiresAt={archiveExpiresAt}
            onOpen={setOpenId}
            onChanged={load}
          />
          {/* Last on the page, after everything it would destroy: a reset offered before
              the reader has seen what they have is a question asked too early. Its count is
              of FACTS across every scope, which is what the dialog's own sentence promises
              against — not the number of files, which a person would read as the size of
              what goes. */}
          <ForgetEverything
            facts={scopes?.reduce((n, s) => n + s.factsTotal, 0) ?? 0}
            onChanged={load}
          />
        </>
      )}

    </SettingsPage>
  );
}
