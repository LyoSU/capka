CREATE TABLE "memory_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"content" text DEFAULT '' NOT NULL,
	"prev_content" text,
	"version" integer DEFAULT 0 NOT NULL,
	"turns_since_consolidation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "memory_docs" ADD CONSTRAINT "memory_docs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_docs" ADD CONSTRAINT "memory_docs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_docs_user_project" ON "memory_docs" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_memory_docs_user_id" ON "memory_docs" USING btree ("user_id");--> statement-breakpoint
-- The composite unique treats NULL project_id as distinct, so it can't stop two
-- user-global docs for one user. A partial unique on (user_id) covers that case.
CREATE UNIQUE INDEX "uniq_memory_docs_user_global" ON "memory_docs" USING btree ("user_id") WHERE "project_id" IS NULL;--> statement-breakpoint
-- Backfill: fold the old per-fact rows into one doc per scope (bulleted, oldest
-- first), capped at the size ceiling. Deterministic id = the scope key, so the
-- grouping guarantees uniqueness. Consolidation tidies anything oversized later.
INSERT INTO "memory_docs" ("id", "user_id", "project_id", "content")
SELECT 'md_' || "user_id" || ':' || coalesce("project_id", ''),
       "user_id",
       "project_id",
       left(string_agg('- ' || "content", E'\n' ORDER BY "created_at"), 3000)
FROM "memories"
GROUP BY "user_id", "project_id";