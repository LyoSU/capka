CREATE TABLE "chat_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"value_enc" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chat_secrets" ADD CONSTRAINT "chat_secrets_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_secrets" ADD CONSTRAINT "chat_secrets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_secrets_chat_name" ON "chat_secrets" USING btree ("chat_id","name");--> statement-breakpoint
CREATE INDEX "idx_messages_content_fts" ON "messages" USING gin (to_tsvector('simple', "content"));