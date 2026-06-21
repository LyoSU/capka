-- Reconcile the two Telegram-linking systems. Accounts linked via the bot's
-- `/link CODE` flow only ever got a `telegram_links` row, never a better-auth
-- `account` row. So a later "Sign in with Telegram" (OIDC) found no matching
-- account and minted a DUPLICATE user. Backfill the missing account rows so the
-- OIDC sign-in resolves to the already-linked user instead.
--
-- account_id is the numeric Telegram id (what the OIDC id_token returns as `id`).
-- Tokenless: better-auth fills tokens on the next sign-in; it only needs the
-- provider+accountId -> user mapping. Idempotent via NOT EXISTS.
INSERT INTO "account" (id, account_id, provider_id, user_id, created_at, updated_at)
SELECT replace(gen_random_uuid()::text, '-', ''), tl.telegram_user_id::text, 'telegram', tl.user_id, now(), now()
FROM telegram_links tl
WHERE NOT EXISTS (
  SELECT 1 FROM "account" a
  WHERE a.provider_id = 'telegram' AND a.account_id = tl.telegram_user_id::text
);
