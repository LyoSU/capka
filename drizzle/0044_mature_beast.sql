CREATE INDEX "idx_chats_sidebar" ON "chats" USING btree ("user_id","archived","pinned","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_chat_role_created" ON "messages" USING btree ("chat_id","role","created_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_chat_status" ON "tasks" USING btree ("chat_id","status");--> statement-breakpoint
CREATE INDEX "idx_tasks_status_created" ON "tasks" USING btree ("status","created_at");