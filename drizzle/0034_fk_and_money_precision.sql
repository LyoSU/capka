ALTER TABLE "models" ALTER COLUMN "input_price" SET DATA TYPE numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "output_price" SET DATA TYPE numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "cache_read_price" SET DATA TYPE numeric(20, 12);--> statement-breakpoint
ALTER TABLE "tiers" ALTER COLUMN "limit_5h" SET DATA TYPE numeric(18, 8);--> statement-breakpoint
ALTER TABLE "tiers" ALTER COLUMN "limit_week" SET DATA TYPE numeric(18, 8);--> statement-breakpoint
ALTER TABLE "tiers" ALTER COLUMN "limit_month" SET DATA TYPE numeric(18, 8);--> statement-breakpoint
ALTER TABLE "usage" ALTER COLUMN "cost_usd" SET DATA TYPE numeric(18, 8);--> statement-breakpoint
-- Reconcile pre-existing orphans before adding the FKs, or the constraint creation
-- fails on rows that already point at a deleted user/project.
UPDATE "chats" SET "project_id" = NULL WHERE "project_id" IS NOT NULL AND "project_id" NOT IN (SELECT "id" FROM "projects");--> statement-breakpoint
DELETE FROM "tasks" WHERE "user_id" NOT IN (SELECT "id" FROM "user");--> statement-breakpoint
DELETE FROM "usage" WHERE "user_id" NOT IN (SELECT "id" FROM "user");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;