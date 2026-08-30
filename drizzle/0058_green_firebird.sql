DROP INDEX "uniq_vclaims_active_slot";--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD COLUMN "approved_by_user_id" text;--> statement-breakpoint
CREATE INDEX "idx_vclaims_slot" ON "vault_claims" USING btree ("space_id","slot_key");