-- Backfill last_read_at for chats that predate the unread indicator. Without
-- this, every existing chat has last_read_at = NULL, so the unread rule
-- (assistant reply newer than last_read_at) flags the ENTIRE history as unread
-- on rollout — a wall of dots that carries no signal. Setting the read
-- watermark to each chat's last activity marks all existing chats read, so only
-- replies that arrive AFTER the upgrade light up. Idempotent (only touches
-- NULLs) and a no-op on fresh installs (no chats yet).
UPDATE "chats" SET "last_read_at" = COALESCE("updated_at", now()) WHERE "last_read_at" IS NULL;
