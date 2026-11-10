CREATE TABLE "background_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_key" text NOT NULL,
	"job_id" text NOT NULL,
	"command" text NOT NULL,
	"chain" integer DEFAULT 0 NOT NULL,
	"turn" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"checked_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_background_jobs_status_chat" ON "background_jobs" USING btree ("status","chat_id");