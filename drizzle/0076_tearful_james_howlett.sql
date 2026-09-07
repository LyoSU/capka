ALTER TABLE "automations" ADD COLUMN "run_when" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "last_skip" jsonb;