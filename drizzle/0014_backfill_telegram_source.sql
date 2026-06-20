-- Backfill: existing Telegram chats predate the source column (0013 defaulted
-- everything to 'web'). Mark any chat that has Telegram-platform messages, or is
-- the pinned active chat of a Telegram link, as source='telegram' so the web UI
-- treats it as read-only.
UPDATE "chats" SET "source" = 'telegram'
WHERE "id" IN (SELECT DISTINCT "chat_id" FROM "messages" WHERE "platform" = 'telegram');
--> statement-breakpoint
UPDATE "chats" SET "source" = 'telegram'
WHERE "id" IN (SELECT "active_chat_id" FROM "telegram_links" WHERE "active_chat_id" IS NOT NULL);
