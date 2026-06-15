CREATE TABLE "skill_files" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"body" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb,
	"source" text DEFAULT 'manual' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_skill_files_skill_id" ON "skill_files" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "idx_skills_user_id" ON "skills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_skills_project_id" ON "skills" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_skills_scope" ON "skills" USING btree ("scope");