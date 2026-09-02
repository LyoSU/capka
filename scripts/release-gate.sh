#!/usr/bin/env bash
#
# Checks a working tree is fit to tag, and is run BY HAND immediately before
# `npm run release`. It is deliberately NOT wired into that script: `release.mjs` refuses a
# dirty tree, and that refusal is its whole guard - a gate failing from inside it would
# leave a half-bumped `package.json` and a rewritten CHANGELOG behind. Every check prints
# PASS or FAIL with the value it read, and the script exits non-zero if any failed so it
# can also sit in CI. The eight checks are the things this repo has actually shipped
# broken: a migration that never applies because its journal timestamp is not the newest,
# a schema edit with no migration generated for it, a page promising an archive deadline
# that has already passed, one locale missing a key the other has, Ukrainian text in code
# rather than in the catalogue, a symbol deleted everywhere but one reference, an empty
# Unreleased section, and a red typecheck.
#
# ONE CHECK CAN WRITE INTO YOUR TREE, and you have to know which. Check 1 runs
# `drizzle-kit generate`, and if the schema has drifted from the snapshots that command
# CREATES a migration under `drizzle/`. The check then fails and NAMES the file, because an
# untracked file in this working directory has no undo and a peer's commit can sweep it -
# review it and either commit it with the release or delete it, but do not leave it lying
# there. Everything else is read-only, and every log the script captures goes into a
# per-run scratch directory whose path is printed below rather than a fixed `/tmp` name
# two concurrent runs would fight over.

# `-e` so a command nobody wrapped in an `if` stops the run instead of being skipped
# silently; every check below is written as a condition or with `|| rc=$?`, so `-e` never
# fires on an ordinary red check and all eight still run. `-u` catches a typo'd variable
# name, which in a gate reads as an empty value and therefore as agreement.
set -euo pipefail

# GUARDED, because the two grep checks below scan RELATIVE paths: from the wrong directory
# `src/` does not exist, grep says so on stderr, and an unguarded script would carry on and
# report the resulting silence as a clean tree. `exit 2` rather than 1 - this is the gate
# failing to run, not a tree failing a check.
cd "$(dirname "$0")/.." || { echo "FAIL  cannot cd to the repository root" >&2; exit 2; }
[ -f package.json ] || { echo "FAIL  $(pwd) is not the repository root (no package.json)" >&2; exit 2; }

# One scratch tree per run, so two concurrent runs never read each other's evidence - up to
# five sessions share this working directory.
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/release-gate.XXXXXX")
CONTROL="$SCRATCH/control"
mkdir -p "$CONTROL"
echo "scratch (logs, control plants): $SCRATCH"
# The trap is what makes an INTERRUPTED run tidy up after itself - without one, every
# `./scripts/release-gate.sh | head` leaves a directory behind forever. A failing run sets
# the flag first, so its logs survive for the operator to read.
KEEP_SCRATCH=0
trap '[ "$KEEP_SCRATCH" = 0 ] && rm -rf "$SCRATCH"' EXIT

fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# GNU grep is not what runs here by default: BSD grep has no -P, and matching Cyrillic by
# its UTF-8 lead bytes under LC_ALL=C is exact on both (U+0400-U+04FF is the only range
# whose encoding starts 0xD0-0xD3, and those bytes are never continuation bytes).
CYRILLIC=$'[\xd0-\xd3]'

# THE KNOWN-ANSWER PLANTS FOR THE TWO GREP CHECKS.
#
# A grep check answers with SILENCE, and silence is produced by a clean tree and by a grep
# that never ran - a missing directory, the wrong working directory, a shim that dies on the
# pattern. Both are `PASS` to a script that only asks whether the output was empty. So each
# grep check runs its pattern against a file that MUST match first, and fails if it does
# not: a check that cannot go red is decoration.
printf 'const s = "%s";\n' 'Привіт' > "$CONTROL/cyrillic-plant.ts"
printf 'resolveMemoryChat memory-composer memory-chat\n' > "$CONTROL/symbol-plant.ts"

# Run a grep and SAY WHAT ITS EXIT STATUS MEANT, instead of inferring it from empty output.
# 0 = matched, 1 = no match, 2+ = grep itself failed. Sets `g_rc`, `g_out`, `g_err`.
grep_scan() {
  g_rc=0
  g_err=$(mktemp "$SCRATCH/grep-err.XXXXXX")
  g_out=$("$@" 2>"$g_err") || g_rc=$?
}

echo "== 1. migrations are generated and the snapshots agree =="
if ./node_modules/.bin/drizzle-kit check >"$SCRATCH/drizzle-check.log" 2>&1; then
  pass "drizzle-kit check: $(tail -1 "$SCRATCH/drizzle-check.log")"
else
  fail "drizzle-kit check failed:"$'\n'"$(tail -3 "$SCRATCH/drizzle-check.log")"
fi
git status --porcelain | sort > "$SCRATCH/tree-before"
gen_rc=0
./node_modules/.bin/drizzle-kit generate >"$SCRATCH/drizzle-generate.log" 2>&1 || gen_rc=$?
gen=$(tail -1 "$SCRATCH/drizzle-generate.log")
git status --porcelain | sort > "$SCRATCH/tree-after"
if [ "$gen_rc" -ne 0 ]; then
  fail "drizzle-kit generate exited $gen_rc:"$'\n'"$(tail -5 "$SCRATCH/drizzle-generate.log")"
else
  case "$gen" in
    *"No schema changes"*) pass "drizzle-kit generate: $gen" ;;
    *) fail "drizzle-kit generate had schema changes to write: $gen" ;;
  esac
fi
# NAME WHAT IT LEFT BEHIND. `git status --porcelain` before and after is what catches a
# generated migration, and the operator needs the path, not the fact - an unnamed untracked
# file in a directory five sessions share is one a peer's commit picks up.
if cmp -s "$SCRATCH/tree-before" "$SCRATCH/tree-after"; then
  pass "generate left the tree unchanged"
else
  fail "generate wrote into the tree - review, then commit with the release or delete:"$'\n'"$(comm -13 "$SCRATCH/tree-before" "$SCRATCH/tree-after")"
fi

echo "== 2. journal timestamps are strictly increasing in idx order =="
# Drizzle's Postgres migrator orders by `when`, not by filename, so a new migration whose
# timestamp is not strictly greater than every earlier one is SILENTLY skipped until
# wall-clock time catches up. Several older entries carry synthetic future timestamps,
# which is exactly how a new one lands below the high-water mark without anyone noticing.
if out=$(python3 - <<'PY'
import json, sys
e = sorted(json.load(open("drizzle/meta/_journal.json"))["entries"], key=lambda x: x["idx"])
bad = [(a["tag"], a["when"], b["tag"], b["when"]) for a, b in zip(e, e[1:]) if b["when"] <= a["when"]]
if bad:
    for a, aw, b, bw in bad:
        print(f"{b} when={bw} is not greater than {a} when={aw}")
    sys.exit(1)
print(f"{len(e)} entries, newest {e[-1]['tag']} when={e[-1]['when']}")
PY
); then pass "journal: $out"; else fail "journal: $out"; fi

echo "== 3. ARCHIVE_RELEASED_ON is within 7 days of today =="
# The memory page states a literal deadline for the retired review queue. The constant is
# the day the code was written; if the tag slips it promises a nearer deadline than the
# thirty days it advertises, and past that date it states one in the past.
if out=$(python3 - <<'PY'
import datetime, re, sys
src = open("src/lib/vault/memory-page.ts", encoding="utf-8").read()
m = re.search(r'ARCHIVE_RELEASED_ON\s*=\s*"(\d{4}-\d{2}-\d{2})"', src)
if not m:
    print("constant not found in src/lib/vault/memory-page.ts"); sys.exit(1)
stamped = datetime.date.fromisoformat(m.group(1))
drift = abs((datetime.date.today() - stamped).days)
print(f"stamped {stamped}, {drift} day(s) from today")
if drift > 7:
    print("re-stamp ARCHIVE_RELEASED_ON to the tag date IN THE RELEASE COMMIT"); sys.exit(1)
PY
); then pass "archive date: $out"; else fail "archive date: $out"; fi

echo "== 4. the two locale catalogues carry the same keys =="
# WHOLE FILES, not just `settings.memory`: `next-intl` renders a missing key as its own
# dotted path rather than throwing, so an absent string ships as a badge reading
# `settings.skills.installed.state.on`. Ukrainian is a first-class locale here.
#
# `manage.*` is the ONE documented asymmetry and it is uk-only BY DESIGN: the chat control
# plane falls back to the in-code English literal rather than to a parallel en catalogue
# that could drift from it. The same carve-out is pinned in
# `src/lib/__tests__/messages.test.ts`; this gate must not disagree with that test, or one
# of the two is noise. Every English key still has to exist in Ukrainian, `manage.`
# included - the exemption runs in one direction only.
if out=$(python3 - <<'PY'
import json, sys
def flat(o, p=""):
    if isinstance(o, dict):
        return {k for kk, vv in o.items() for k in flat(vv, f"{p}.{kk}" if p else kk)}
    return {p}
en = flat(json.load(open("messages/en.json", encoding="utf-8")))
uk = flat(json.load(open("messages/uk.json", encoding="utf-8")))
only_en = sorted(en - uk)
only_uk = sorted(k for k in uk - en if not k.startswith("manage."))
if only_en or only_uk:
    for k in only_en[:20]: print(f"untranslated (en only): {k}")
    for k in only_uk[:20]: print(f"orphan (uk only): {k}")
    print(f"{len(only_en)} untranslated, {len(only_uk)} orphaned"); sys.exit(1)
print(f"{len(en)} en keys all translated; {len(uk - en)} uk-only, all under the `manage.` carve-out")
PY
); then pass "i18n parity: $out"; else fail "i18n parity: $out"; fi

echo "== 5. no Cyrillic in src/ outside the exception list =="
# UI copy lives in messages/*.json. The exceptions are the locale roster itself, the error
# page that renders before any provider is mounted, and the extraction/eval corpus, whose
# specimens are Ukrainian by design.
# The positive control first: the same pattern, the same grep, against a planted file.
LC_ALL=C grep_scan grep -rlI "$CYRILLIC" "$CONTROL"
if [ "$g_rc" -ne 0 ]; then
  fail "control: the Cyrillic pattern did not match a planted file (grep exit $g_rc)"$'\n'"$(cat "$g_err")"
else
  LC_ALL=C grep_scan grep -rlI "$CYRILLIC" src/
  case "$g_rc" in
    0)
      offenders=$(printf '%s\n' "$g_out" | grep -v \
        -e '^src/i18n/config\.ts$' \
        -e '^src/app/global-error\.tsx$' \
        -e '^src/lib/vault/extract\.ts$' \
        -e '^src/lib/vault/__tests__/extract\.test\.ts$' \
        -e '^src/lib/vault/eval/' | sort) || offenders=""
      if [ -z "$offenders" ]; then
        pass "no Cyrillic outside the 5 exceptions ($(printf '%s\n' "$g_out" | wc -l | tr -d ' ') matched file(s), all excepted)"
      else
        fail "Cyrillic in code:"$'\n'"$offenders"
      fi
      ;;
    1) pass "no Cyrillic anywhere under src/" ;;
    *) fail "grep failed while scanning src/ (exit $g_rc):"$'\n'"$(cat "$g_err")" ;;
  esac
fi

echo "== 6. the removed memory-chat symbols are gone everywhere =="
# `chats.kind` and its unique index were dropped; a surviving reference means one of the
# two halves of that removal did not land.
for sym in resolveMemoryChat memory-composer memory-chat; do
  # Control first, for the same reason as check 5: 0 hits is also what a grep that never
  # ran reports, and this symbol is the one file where it must be found.
  grep_scan grep -rn "$sym" "$CONTROL"
  if [ "$g_rc" -ne 0 ]; then
    fail "control: '$sym' was not found in the planted file (grep exit $g_rc)"$'\n'"$(cat "$g_err")"
    continue
  fi
  grep_scan grep -rn "$sym" src drizzle
  case "$g_rc" in
    0) fail "$sym: $(printf '%s\n' "$g_out" | wc -l | tr -d ' ') hit(s)"$'\n'"$(printf '%s\n' "$g_out" | head -5)" ;;
    1) pass "$sym: 0 hits in src drizzle" ;;
    *) fail "grep failed while scanning for '$sym' (exit $g_rc):"$'\n'"$(cat "$g_err")" ;;
  esac
done

echo "== 7. CHANGELOG has a non-empty [Unreleased] section =="
if out=$(python3 - <<'PY'
import re, sys
text = open("CHANGELOG.md", encoding="utf-8").read()
m = re.search(r"^## \[Unreleased\]\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
if not m:
    print("no `## [Unreleased]` heading"); sys.exit(1)
lines = [l for l in m.group(1).splitlines() if l.strip()]
if not lines:
    print("[Unreleased] is empty - a release with no operator-visible note is a release nobody can read"); sys.exit(1)
print(f"{len([l for l in lines if l.startswith('- ')])} entries under {len([l for l in lines if l.startswith('###')])} heading(s)")
PY
); then pass "changelog: $out"; else fail "changelog: $out"; fi

echo "== 8. typecheck and lint =="
if ./node_modules/.bin/tsc --noEmit >"$SCRATCH/tsc.log" 2>&1; then
  pass "tsc --noEmit clean"
else
  fail "tsc --noEmit:"$'\n'"$(tail -20 "$SCRATCH/tsc.log")"
fi
if npm run lint >"$SCRATCH/lint.log" 2>&1; then
  pass "lint clean: $(tail -1 "$SCRATCH/lint.log")"
else
  fail "npm run lint:"$'\n'"$(tail -20 "$SCRATCH/lint.log")"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "RELEASE GATE: PASS - the tree is fit to tag."
else
  # Nothing to read after a clean run, so the trap takes the scratch with it. After a
  # failure the logs the FAIL lines quote from are in there, so keep them.
  KEEP_SCRATCH=1
  echo "RELEASE GATE: FAIL - $fails check(s) failed. Do not tag."
  echo "logs: $SCRATCH"
fi
exit "$fails"
