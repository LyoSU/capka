CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sandbox_network" text DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_chat_id" ON "tasks" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_user_id_status" ON "tasks" USING btree ("user_id","status");