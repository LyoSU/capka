CREATE TABLE "plugin_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"marketplace_id" text NOT NULL,
	"plugin_name" text NOT NULL,
	"version" text,
	"scope" text DEFAULT 'system' NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb,
	"installed_by" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "plugin_marketplaces" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"owner" text,
	"catalog" jsonb DEFAULT '[]'::jsonb,
	"refreshed_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "plugin_installs" ADD CONSTRAINT "plugin_installs_marketplace_id_plugin_marketplaces_id_fk" FOREIGN KEY ("marketplace_id") REFERENCES "public"."plugin_marketplaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_installs" ADD CONSTRAINT "plugin_installs_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plugin_installs_marketplace" ON "plugin_installs" USING btree ("marketplace_id");