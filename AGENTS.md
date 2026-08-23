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

A pathspec commit still does **not** separate two sessions' edits *inside* one
file: it commits that file's whole working state. When a file holds both, do not
patch — `git show HEAD:<path>` into place, re-apply only your own change as a
literal string replacement, commit explicit paths, then restore the saved copy.
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

Corollary, from an agent who lost ten minutes to it the same night: never write
`2>/dev/null` while establishing a fact. It turned a missing binary into an empty
file with exit 0, which then read as evidence. The same night another session
survived the mirror image of it only because stderr was *not* suppressed — it had
`cd`'d out of the repo, and "not a git repository" is what stopped five silent
zeros from becoming findings.
<!-- END:shared-worktree-rules -->
