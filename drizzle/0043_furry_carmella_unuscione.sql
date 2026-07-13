ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_projects_deleted_at" ON "projects" USING btree ("deleted_at") WHERE deleted_at is not null;