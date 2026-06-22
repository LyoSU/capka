ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "cutoff" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "open_weights" boolean;