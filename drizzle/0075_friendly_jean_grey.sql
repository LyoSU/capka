CREATE TABLE "automation_webhook_deliveries" (
	"automation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "automation_webhook_deliveries_automation_id_idempotency_key_pk" PRIMARY KEY("automation_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "webhook_token" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "max_runs_per_day" integer;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "runs_day" date;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "runs_today" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "skipped_today" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "thread_mode" text DEFAULT 'fresh' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "thread_chat_id" text;--> statement-breakpoint
ALTER TABLE "automation_webhook_deliveries" ADD CONSTRAINT "automation_webhook_deliveries_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_automation_webhook_deliveries_created_at" ON "automation_webhook_deliveries" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_webhook_token_unique" UNIQUE("webhook_token");