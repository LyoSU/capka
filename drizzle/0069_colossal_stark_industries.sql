ALTER TABLE "chats" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_notes" ADD COLUMN "section" text DEFAULT 'topic' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_chats_memory" ON "chats" USING btree ("user_id") WHERE "chats"."kind" = 'memory';--> statement-breakpoint
ALTER TABLE "vault_notes" ADD CONSTRAINT "ck_vnotes_section" CHECK ("vault_notes"."section" in ('you','topic','area','person'));