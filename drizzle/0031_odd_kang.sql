ALTER TABLE "usage" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_usage_task_pending" ON "usage" USING btree ("task_id","pending");