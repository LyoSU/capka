DROP INDEX "uniq_vnotes_memory_topic";--> statement-breakpoint
ALTER TABLE "vault_notes" ADD COLUMN "topic_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vnotes_memory_topic" ON "vault_notes" USING btree ("space_id","topic_key") WHERE "vault_notes"."kind" = 'memory_topic';