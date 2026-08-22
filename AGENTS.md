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
`npx tsc --noEmit && npx vitest run`.

Release note: the version is decided by what is *in the range*, not by intent — a
peer's `feat` landing in the range makes it a minor even if a patch was requested.

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
<!-- END:shared-worktree-rules -->
