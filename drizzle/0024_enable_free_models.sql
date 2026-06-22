-- Free OpenRouter models (":free" variants) were excluded from default curation
-- by the parser's NOISY_TAG + `price > 0` gate, then frozen at enabled=false
-- because re-sync preserves the `enabled` column (admin curation). Now that the
-- parser surfaces them, flip the rows already stored so existing installs show
-- free models in the picker without waiting on a manual catalog re-sync.
UPDATE "models" SET "enabled" = true
WHERE "source" = 'openrouter'
  AND "id" LIKE '%:free'
  AND "context_length" >= 8000
  AND "input_price" IS NOT NULL;
