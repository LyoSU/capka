ALTER TABLE "chats" ADD COLUMN "active_leaf_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_active_leaf_id_messages_id_fk" FOREIGN KEY ("active_leaf_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_id_messages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_messages_parent_id" ON "messages" USING btree ("parent_id");--> statement-breakpoint
UPDATE "messages" m SET "parent_id" = o.prev_id FROM (
  SELECT id, LAG(id) OVER (PARTITION BY chat_id ORDER BY created_at, id) AS prev_id FROM "messages"
) o WHERE m.id = o.id AND o.prev_id IS NOT NULL;--> statement-breakpoint
UPDATE "chats" c SET "active_leaf_id" = lm.id FROM (
  SELECT DISTINCT ON (chat_id) chat_id, id FROM "messages" ORDER BY chat_id, created_at DESC, id DESC
) lm WHERE c.id = lm.chat_id;
