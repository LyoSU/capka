ALTER TABLE "vault_notes" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "vault_notes" ADD COLUMN "retired_at" timestamp;--> statement-breakpoint
ALTER TABLE "vault_notes" ADD COLUMN "last_used_at" timestamp;