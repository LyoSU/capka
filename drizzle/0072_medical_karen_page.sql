ALTER TABLE "models" ADD COLUMN "first_seen_at" timestamp DEFAULT now();--> statement-breakpoint
-- `ADD COLUMN ... DEFAULT now()` just stamped TODAY onto every existing row, which
-- would make the entire catalog read as new on the deploy that adds this column.
-- Their real first-seen date is unknown, and `updated_at` cannot stand in for it:
-- the sync rewrites that column on every pass, so on a live instance it says
-- "hours ago" for models that have been there since the first boot. Blank them —
-- the picker reads NULL as "not new", so unknown stays unknown.
UPDATE "models" SET "first_seen_at" = NULL;
