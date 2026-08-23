<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:shared-worktree-rules -->
# Several agents share this working directory

`/Users/ly/dev/unclaw` is a single working directory that up to five Claude
sessions edit at once, all committing straight to `master` as the same git user.
The working tree, the index, and the stash are shared global state. Authorship in
the log cannot tell two sessions apart. Everything below was paid for at least
once; none of it is derivable from the code.

`ListAgents` shows the other sessions; `SendMessage` reaches them by bare name.
Announce a file boundary before editing, and ask the user rather than deciding a
split alone — they know what the other sessions are doing.

## Never `git add` in this repo

The index is shared, so staging is handing your work to whoever commits next.
This happened twice in one day: once sweeping another session's in-flight
refactor plus a 154-line file it was mid-delete, once sweeping nine staged files
under an unrelated feature message. Both survived only because the work was also
still in the working tree.

Use `git commit -- <explicit paths>`. It reads the working tree for those paths
and leaves the index alone, so it cannot give your work away — and it is much
harder to get wrong under time pressure than any clever alternative. `git add -A`
is banned outright.

**A pathspec commit cannot commit a file git does not track yet.** `git commit --
drizzle/0054_x.sql` dies with `did not match any file(s) known to git`, and the
obvious fix is the banned one. Use a PRIVATE index — it is not shared, so the reason
behind the ban does not apply to it:

```
export GIT_INDEX_FILE=/tmp/mine.index
git read-tree HEAD
git add -- <your paths>     # writes only to /tmp/mine.index
git commit -F msg           # commits that index; .git/index is never touched
```

Assert both halves: with `GIT_INDEX_FILE` set, `git diff --cached --name-only` must
list exactly your paths; with it unset, it must be empty.

**Then refresh the shared index, or you have armed the very thing you were avoiding.**
That commit moves HEAD while `.git/index` still holds the PRE-commit blobs for your
paths — for a new file, its DELETION — so `git diff --cached` now lists them as staged,
and a peer's pathspec-less `git commit` would commit those stale blobs, reverting you.
Reset **only your own paths**: `git reset -q -- <your paths>`.

A bare `git reset -q` is what this file prescribed until it was measured. It resets the
WHOLE index, so a peer's staged new file goes from `A peer.txt` to `?? peer.txt`. Their
content survives — a mixed reset does not touch the working tree — but the file lands
back in the one state this file calls un-undoable, and staging is how work gets handed
on here, so destroying it is the same harm from the other side. The pathspec form is not
a refinement: index-wide is index-wide, and the bare reset is the banned `git add -A`
with its sign flipped.

A pathspec commit still does **not** separate two sessions' edits *inside* one
file: it commits that file's whole working state. When a file holds both, do not
patch — `git show HEAD:<path>` into place, re-apply only your own change as a
literal string replacement, commit explicit paths, then put the OTHER session's
lines back with a second literal replacement.

**That last step is not "restore your saved copy".** Restoring a whole saved file is
a read-modify-write with a *commit* sitting in the middle of it — about the widest
window you can hand a peer in a shared directory. Anything they wrote to that file
between your save and your restore is gone, silently, and because it was never
committed git holds no copy to recover it from. Two literal replacements have no
window for any content except the one line you are moving. The recipe used to end
"restore the saved copy"; a session followed it exactly, restored the whole file, and
nothing was lost only because nothing landed in the window — which is luck, not a
property of the procedure.

`git apply --cached --unidiff-zero` on `-U0` hunks **reorders code**, because the
other session's intervening hunks shift the offsets; it has put a declaration
after its own use and turned `master` red (TS2448) while the author's own tree
still compiled. Assert on the result before staging.

## Attribution: read the diff, never the file

"Is my work in this file" is the wrong question and gives the wrong answer — a
token present in a file says nothing about who holds an uncommitted change to it.
Ask "is my work in this **diff**":

```bash
git diff HEAD -- <path> | grep '^+' | grep -E '<their tokens>'   # theirs?
git show HEAD:<path>    | grep -c '<their tokens>'               # or already committed?
```

**Assert positively; a clean pre-check is not a guarantee.** "I confirmed the
index was empty first" fails open: it asserts a *moment*, and a commit is an
*object*. That holds whichever way the moment gets falsified — a peer staging
between your check and your commit, or a bad count from the tooling caveat below.
Two such alarms did occur and proved unreproducible a minute later, cause
undetermined between exactly those two. Since `git commit -- <paths>` never
stages, make the assertion on the *result*: `git show --stat --format="" HEAD`
must list exactly the paths you intended, and `git diff --cached --name-only`
must still be empty. That fails closed.

A session once reported two files as jointly held — blocking another session for
half an hour — because it read the file while the other half was already in
`HEAD`. Classifying hunks by a keyword list fails the same way and worse: the
list goes stale, new work matches nothing, and "matched neither list" reads as
"mine". Treat no-match as STOP, not as ownership.

**Ownership by elimination is the same error with better manners.** An agent read
`git status`, subtracted the files it knew were its own, and assigned the remainder to
the one peer it happened to be talking to. Wrong: a third session held them. Every
individual fact was true and the inference assumed there were two of us; `ListAgents`
listed ten. Absence of your work in a file is not presence of a particular peer's.

The useful half: the split recipe above is safe WITHOUT knowing the owner — save the
combined file, `git show HEAD:<path>`, re-apply only your own lines, commit, then
re-insert only THEIRS. Its correctness does not depend on the guess, which is why it held
while the guess was wrong. Prefer a procedure with that property over being right
about attribution.

**A diff read is a timestamped fact and it expires.** One correct diff read went
stale eight minutes later when the other session's commit moved those very lines
into `HEAD`. Re-check immediately before committing, not once at the start.

## Untracked files may be someone else's, and have no undo

Untracked means git holds no copy, so a bad overwrite is unrecoverable — none of
the recipes above apply. An agent lost part of a peer's rewritten `docs/BACKLOG.md`
by running a patch script against a file it believed it owned because it had
created it. **Never read-modify-write a file you do not currently hold.** Prefer
appending (`cat >>`) over rewriting, check `stat` mtime immediately before
writing, and treat a recent mtime as a live editor rather than stale state.

## Verify the commit, not the directory

"Green" is a claim about a commit; in a shared directory the directory is not a
commit. Print `git status --porcelain` before **and** after any verification run —
a peer's write mid-run makes the result describe a tree that no longer exists.
Before moving a branch or cutting a tag, check the commit itself:
`git worktree add --detach /tmp/v <sha>`, symlink `node_modules`, then
`npx tsc --noEmit && npx vitest run`. Symlink **two** module trees, not one:
`sandbox-controller/` has its own `package.json`, so a single root symlink leaves
its suites failing with `Cannot find package 'dockerode'`. And the integration
suites are gated on `RUN_INTEGRATION=1`, which you must set by hand — the npm
script deliberately does not. Do not "fix" that: the gate is what stops those
suites, which truncate tables, from ever being pointed at a real database by
accident. CI supplies it as a job-level env in `.github/workflows/ci.yml`
alongside a throwaway Postgres service, so CI is not silently skipping them.

Read a run's **skip** count, not only its failures. A jump in skips (1 → 23, or
3 passed / 193 skipped) means a precondition collapsed — an unset gate, a
`beforeAll` that threw, a database with no schema — and reporting it as a result
sends the next hour somewhere useless. Likewise a suite that "failed" with 0
failed tests is a module that would not load, not a broken assertion. Assert
preconditions explicitly instead of inferring them: after migrating, require the
table count to be what the schema says.

Authorship cannot be inferred, only reported. Every session commits as the same
git user, so `%an`, `%ae` and `%cn` are identical for all of them and no git field
separates two agents; absence from your own record is not evidence of someone
else's authorship. Ask the other session.

And be ready for asking to fail, because **a session's name is not stable and it
may not know its own.** Two boundary announcements arrived under different names,
claiming overlapping files for adjacent findings of one audit; four sessions
independently concluded there was a collision to sequence, from facts that were all
correct. There was one session. It could not have answered a "who are you" question
correctly at the time either — the earlier name was gone from `ListAgents` within
minutes, which reads exactly like a session that vanished mid-edit.

So the durable identifier is the **commit**, not the session. `git log -S "<a
distinctive string>" -- <path>` names which commit introduced a line, and a session
can confirm or deny a sha; a name is a handle that may already be void by the time
you use it. When a claim and a tree disagree, look for the work in the history
before concluding anyone is racing anyone: two of those "in flight" claims were
already committed.

Release note: the version is decided by what is *in the range*, not by intent — a
peer's `feat` landing in the range makes it a minor even if a patch was requested.

**Cutting the tag IS the deploy.** `publish-images.yml` moves the `stable` branch
to the released commit, and the public demo redeploys itself on a `stable` push.
Nobody triggers that and nobody is asked. So the decision to deploy is taken
several steps upstream, by whoever runs `npm run release`, and it is irreversible
by the time anyone thinks to ask about it — a manual deploy afterwards is a
duplicate of one that already ran. "Should we redeploy?" is the wrong question;
"should this tag exist yet?" is the real one.

Two consequences when checking whether the deploy landed. A deployment reporting
**finished** is not the moment the new build serves: the platform container still
has to boot, and that gap has been minutes. And prefer a control with a **known
answer** over one with a known **time** — a timestamp only helps once you have
identified the right event, and an agent has now three times recorded a "before"
reading that was taken after the thing it meant to precede. Comparing a build
fingerprint against the *previous release's* recorded value proves which build is
being served no matter when the reading was taken.

That rule is necessary and not sufficient: **a control must be able to change when
the event happens.** A build fingerprint taken from `/login` cannot witness a
release that only touched the chat bundle — the chunk names are legitimately
identical, so the probe returns "unchanged" however perfectly it is timed, and
"unchanged" reads as "the deploy did not take". A demo that was already correct
gets redeployed on the strength of it. Prefer a quantity that changes by
construction: the deployment's own container identity, a `Pull complete` in its
log, the running image digest. Before trusting any check, ask what reading it
would have produced had the answer been the opposite — if that is the same
reading, the check is decoration.

## If you do sweep someone's work

1. `git status -sb` — a quiet repair is only possible while nothing is pushed.
2. `SendMessage` the affected session **before** touching anything.
3. `git reset --soft HEAD~1 && git restore --staged .` — moves HEAD, changes no
   file content, so their work simply goes back to being uncommitted.
4. Split shared files by the `git show`/literal-replacement route above.

Never push another session's commits: that is the user's call, not yours.

## Tooling caveat

`grep` through the rtk proxy has returned false counts here (`0` for a symbol
that is present, `1` where there are two), which has caused an agent to conclude
it had lost work and nearly redo it. For anything load-bearing use
`/usr/bin/grep` or `npx tsc --noEmit`.

It also **summarizes** output, which is worse than miscounting it, because the
result is well-formed. A `curl` of a 401 came back as `{ error: string }` — 20
bytes, verified with `od -c` — where the server had sent `{"error":"Unauthorized"}`:
the value replaced by its *type*. An agent was one message from reporting that a
live endpoint serves a TypeScript type instead of a body. A wrong number looks
wrong; a schema standing where a value belongs looks like a finding. So for
anything you intend to report, get the bytes another way (`rtk proxy <cmd>`,
`od -c`, a file) and include a request whose answer you already know — the
control is what exposes the substitution, since the distorted output is
internally consistent.

Bulk output can come back **silently short**, and the piece you get is a valid
artifact. On one release range a `git diff` of 8150 lines / 338373 bytes arrived
as 572 lines of well-formed hunks, exit 0 — a fourteenth of the change looking
exactly like the whole change. An audit fed that reviews 7% of a release and
reports on all of it.

**Do not encode a safe invocation shape; there isn't one.** Two sessions each
inferred a boundary from two measurements and each was refuted by the other's:
one saw a redirect truncate while a pipe was complete, the other the exact
reverse. Then the byte-identical commands that had truncated came back complete
six times running for both of us. It is non-deterministic, so any "this form is
safe" rule reads as true for a while and then does not.

What does work, and is cheaper than either theory:

1. **Read the artifact's tail.** The truncated file announces itself — one
   session found `... (more changes truncated)` and `[full diff: rtk git diff
   --no-compact]` at the end of it. Neither of us saw that for hours, because we
   measured the file with `wc -l` and compared against `--stat` instead of
   opening it. A truncation marker is worthless to an agent that only ever
   measures.
2. **Check the size against an independent control.** `--shortstat` said 57
   files / 6822 insertions, which cannot fit in 572 lines.

The general rule: **never let the proxy be the only witness to a number, a body,
or a size you are about to act on.** And note how both wrong mechanisms were
produced — by inferring from measurements without looking at the thing measured,
which is the very failure this section is about. A caveat asserting a cause it
has not checked belongs here as much as a log line does.

Three more from one night, none of which the advice above covers.

**A reformat can make a whole grep class silently empty.** `git diff | grep '^+'`
returned NOTHING for a diff with fourteen insertions: the proxy re-renders a diff as a
summary (`--- Changes ---`, `+1 -0`), so no line begins with `+` any more. Not a wrong
count, and not a value replaced by its type — the pattern simply stops matching, and an
empty result reads as "none of my work is in this file", which is precisely the
conclusion you must never reach by accident.

**`rtk proxy <cmd>` is named above as the escape hatch and is not always one.** For
that same diff it reported the correct size (3355 bytes) with the body truncated behind
`// ... 56 lines omitted`. Only `/usr/bin/git --no-pager diff` produced all 58 lines,
and only then did the insertion count agree with `--shortstat`. For git, the escape
hatch is the real binary, not the proxy.

**And it differs by COMMAND, not only by invocation shape.** The same night, one
session's `rtk proxy git diff` truncated while another's `rtk proxy npx vitest run` was
honest — and that session's plain `vitest | grep` came back empty while its redirect
gave a truncated log pointing at a `[full output: …]` file that also lacked the summary.
So "no safe shape" extends to "no safe command": do not promote either observation into
a rule.

One the proxy cannot be blamed for: **the artifact you measure must be the artifact you
produced.** An agent ran `vitest run 2>&1 | tail -8 > out`, then half an hour later
asked `out` which test had failed. It is 351 bytes and cannot answer — and `wc -c` is
what revealed that, not reading it. Truncating your own output is indistinguishable,
after the fact, from the tool truncating it.

Corollary, from an agent who lost ten minutes to it the same night: never write
`2>/dev/null` while establishing a fact. It turned a missing binary into an empty
file with exit 0, which then read as evidence. The same night another session
survived the mirror image of it only because stderr was *not* suppressed — it had
`cd`'d out of the repo, and "not a git repository" is what stopped five silent
zeros from becoming findings.
<!-- END:shared-worktree-rules -->
