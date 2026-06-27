-- Dedup any pre-existing duplicate holds first, or the unique index can't be
-- created. Keep one pending row per task_id, drop the rest (they're estimates
-- that would otherwise have double-counted at reconcile).
DELETE FROM "usage" a
USING "usage" b
WHERE a."pending" = true
  AND b."pending" = true
  AND a."task_id" IS NOT NULL
  AND a."task_id" = b."task_id"
  AND a.ctid < b.ctid;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_one_pending_per_task" ON "usage" USING btree ("task_id") WHERE pending;