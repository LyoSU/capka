ALTER TABLE "usage" ADD COLUMN "config_id" text;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_config_id_provider_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_config_created" ON "usage" USING btree ("config_id","created_at");