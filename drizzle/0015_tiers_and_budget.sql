CREATE TABLE "tiers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"limit_5h" numeric,
	"limit_week" numeric,
	"limit_month" numeric,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "on_shared_key" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "tier_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "tier_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_tiers_is_default" ON "tiers" USING btree ("is_default");--> statement-breakpoint
--> Seed the instance default tier (unlimited until an admin sets caps).
INSERT INTO "tiers" ("id", "name", "limit_5h", "limit_week", "limit_month", "is_default")
VALUES ('default', 'Default', NULL, NULL, NULL, true)
ON CONFLICT ("id") DO NOTHING;