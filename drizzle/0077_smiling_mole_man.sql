ALTER TABLE "automations" ADD COLUMN "quiet_today" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "notify_mode" text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "deliver_telegram" boolean DEFAULT true NOT NULL;