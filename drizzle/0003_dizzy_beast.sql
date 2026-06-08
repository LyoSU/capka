CREATE TABLE "usage" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"message_id" text,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"cached_input_tokens" integer DEFAULT 0,
	"cost_usd" numeric,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancel_requested" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "attempts" integer DEFAULT 0;--> statement-breakpoint
CREATE INDEX "idx_usage_user_created" ON "usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_model" ON "usage" USING btree ("model");--> statement-breakpoint
CREATE INDEX "idx_tasks_status_lease" ON "tasks" USING btree ("status","lease_expires_at");