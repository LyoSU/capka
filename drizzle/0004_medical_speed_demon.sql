CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"display_name" text NOT NULL,
	"group" text,
	"icon" text,
	"context_length" integer,
	"input_price" numeric,
	"output_price" numeric,
	"cache_read_price" numeric,
	"capabilities" jsonb,
	"enabled" boolean DEFAULT false,
	"featured" boolean DEFAULT false,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_models_group" ON "models" USING btree ("group");--> statement-breakpoint
CREATE INDEX "idx_models_enabled" ON "models" USING btree ("enabled");