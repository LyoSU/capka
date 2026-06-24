-- Defensive: collapse any pre-existing duplicate pending turns BEFORE the unique
-- index goes on, so the migration can never fail on historical data. Keep the
-- oldest queued turn per chat (the next one in line); the others' user messages
-- are already persisted, so the survivor folds them in when it rebuilds the
-- conversation from the live tree at run time. Safe to delete — a queued task
-- holds no running work and owns no lease.
DELETE FROM "tasks" t
 USING "tasks" keep
 WHERE t.status = 'queued'
   AND keep.status = 'queued'
   AND t.chat_id = keep.chat_id
   AND (t.created_at, t.id) > (keep.created_at, keep.id);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tasks_one_queued_per_chat" ON "tasks" USING btree ("chat_id") WHERE status = 'queued';
