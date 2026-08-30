ALTER TABLE "vault_claims" ADD COLUMN "source_class" text;--> statement-breakpoint
UPDATE "vault_claims" SET "source_class" =
  CASE WHEN "review_status" = 'confirmed' THEN 'legacy_confirmed' ELSE 'agent_inferred' END
  WHERE "source_class" IS NULL;--> statement-breakpoint
ALTER TABLE "vault_claims" ALTER COLUMN "source_class" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD CONSTRAINT "ck_vault_claims_source_class" CHECK ("vault_claims"."source_class" in ('legacy_confirmed','owner_authored','user_direct','agent_inferred','untrusted_derived'));--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "prompt_access" text GENERATED ALWAYS AS (case when sensitive then 'owner_only'
               when source_class in ('legacy_confirmed','owner_authored','user_direct') then 'manifest'
               when source_class = 'agent_inferred' then 'memory_search'
               else 'knowledge_search' end) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "conflicts_with" text;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "normalized_hash" text;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "created_task_id" text;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "retired_at" timestamp;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD CONSTRAINT "vault_claims_conflicts_with_fk" FOREIGN KEY ("space_id","conflicts_with") REFERENCES "public"."vault_nodes"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vclaims_prompt_access" ON "vault_claims" USING btree ("space_id","prompt_access") WHERE "vault_claims"."superseded_at" IS NULL AND "vault_claims"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vclaims_norm_hash" ON "vault_claims" USING btree ("space_id","normalized_hash") WHERE "vault_claims"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vclaims_conflicts_with" ON "vault_claims" USING btree ("conflicts_with") WHERE "vault_claims"."conflicts_with" IS NOT NULL;
