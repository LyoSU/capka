-- Until 0.46.x every Claude model was asked to think with the manual budget
-- shape (`thinking.type: "enabled"`). Claude 4.7 and every Claude 5 reject it
-- with a 400 ("thinking.type.enabled" is not supported for this model), which
-- isReasoningUnsupportedError matched, so rememberModelCannotReason stored
-- `noReasoning: true` — and, on a model the catalog had no row for, a stub with
-- `reasoning: false`, which hides the thinking control. Those models now get
-- adaptive thinking, but the stored flag would keep it from ever being sent.
--
-- Cleared for exactly the ids claudeTakesBudget (src/lib/models/thinking.ts)
-- now sends the adaptive shape to: Claude ids that are neither pre-4 naming nor a
-- readable opus/sonnet/haiku version below 4.6 (an unreadable version counts as
-- adaptive there, so it does here). Every such model reasons, so `reasoning` is
-- set true as well. Over-clearing is harmless: a model that really cannot reason
-- 400s once more and the runner learns the flag again.
UPDATE "models"
SET "capabilities" = ("capabilities" - 'noReasoning') || '{"reasoning": true}'::jsonb
WHERE "capabilities" -> 'noReasoning' = 'true'::jsonb
  AND lower("id") LIKE '%claude%'
  AND lower("id") !~ 'claude-(?:instant|[123](?:[-.]\d)?(?:-|$))'
  AND coalesce((
    SELECT m[1]::numeric * 10 + coalesce(m[2], '0')::numeric
    FROM regexp_match(lower("id"), 'claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d)(?!\d))?') AS m
  ), 99) >= 46;
