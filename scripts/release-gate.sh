#!/usr/bin/env bash
#
# Checks a working tree is fit to tag, and is run BY HAND immediately before
# `npm run release`. It is deliberately NOT wired into that script: `release.mjs` refuses a
# dirty tree, and that refusal is its whole guard - a gate failing from inside it would
# leave a half-bumped `package.json` and a rewritten CHANGELOG behind. Every check prints
# PASS or FAIL with the value it read, none of them writes anything, and the script exits
# non-zero if any failed so it can also sit in CI. The eight checks are the things this
# repo has actually shipped broken: a migration that never applies because its journal
# timestamp is not the newest, a schema edit with no migration generated for it, a page
# promising an archive deadline that has already passed, one locale missing a key the other
# has, Ukrainian text in code rather than in the catalogue, a symbol deleted everywhere but
# one reference, an empty Unreleased section, and a red typecheck.

set -uo pipefail
cd "$(dirname "$0")/.."

fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# GNU grep is not what runs here by default: BSD grep has no -P, and matching Cyrillic by
# its UTF-8 lead bytes under LC_ALL=C is exact on both (U+0400-U+04FF is the only range
# whose encoding starts 0xD0-0xD3, and those bytes are never continuation bytes).
CYRILLIC=$'[\xd0-\xd3]'

echo "== 1. migrations are generated and the snapshots agree =="
if ./node_modules/.bin/drizzle-kit check >/tmp/rg-check.log 2>&1; then
  pass "drizzle-kit check: $(tail -1 /tmp/rg-check.log)"
else
  fail "drizzle-kit check failed: $(tail -3 /tmp/rg-check.log)"
fi
before=$(git status --porcelain | sort)
gen=$(./node_modules/.bin/drizzle-kit generate 2>&1 | tail -1)
after=$(git status --porcelain | sort)
case "$gen" in
  *"No schema changes"*) pass "drizzle-kit generate: $gen" ;;
  *) fail "drizzle-kit generate wrote a migration - commit it before tagging: $gen" ;;
esac
if [ "$before" = "$after" ]; then
  pass "generate left the tree unchanged"
else
  fail "generate changed the tree:"$'\n'"$(diff <(echo "$before") <(echo "$after"))"
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
offenders=$(LC_ALL=C grep -rlI "$CYRILLIC" src/ 2>/dev/null | grep -v \
  -e '^src/i18n/config\.ts$' \
  -e '^src/app/global-error\.tsx$' \
  -e '^src/lib/sandbox/sandbox-probes\.ts$' \
  -e '^src/lib/vault/extract\.ts$' \
  -e '^src/lib/vault/__tests__/extract\.test\.ts$' \
  -e '^src/lib/vault/eval/' | sort)
if [ -z "$offenders" ]; then
  pass "no Cyrillic outside the 6 exceptions"
else
  fail "Cyrillic in code:"$'\n'"$offenders"
fi

echo "== 6. the removed memory-chat symbols are gone everywhere =="
# `chats.kind` and its unique index were dropped; a surviving reference means one of the
# two halves of that removal did not land.
for sym in resolveMemoryChat memory-composer memory-chat; do
  hits=$(grep -rn "$sym" src drizzle 2>/dev/null | wc -l | tr -d ' ')
  if [ "$hits" = "0" ]; then pass "$sym: 0 hits in src drizzle"; else
    fail "$sym: $hits hit(s)"$'\n'"$(grep -rn "$sym" src drizzle 2>/dev/null | head -5)"
  fi
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
if ./node_modules/.bin/tsc --noEmit >/tmp/rg-tsc.log 2>&1; then
  pass "tsc --noEmit clean"
else
  fail "tsc --noEmit:"$'\n'"$(tail -20 /tmp/rg-tsc.log)"
fi
if npm run lint >/tmp/rg-lint.log 2>&1; then
  pass "lint clean: $(tail -1 /tmp/rg-lint.log)"
else
  fail "npm run lint:"$'\n'"$(tail -20 /tmp/rg-lint.log)"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "RELEASE GATE: PASS - the tree is fit to tag."
else
  echo "RELEASE GATE: FAIL - $fails check(s) failed. Do not tag."
fi
exit "$fails"
