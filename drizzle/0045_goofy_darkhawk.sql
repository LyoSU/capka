-- Pre-clean duplicate rules before the unique indexes below can be created.
-- Keep the newest updated_at per (scope, subject, capability); drop the rest.
-- coalesce collapses the null subject columns so all three scopes group correctly.
DELETE FROM "capability_policies" a USING (
  SELECT id, row_number() OVER (
    PARTITION BY scope, coalesce(user_id, ''), coalesce(project_id, ''), capability_type, capability_key
    ORDER BY updated_at DESC NULLS LAST, id DESC
  ) AS rn
  FROM "capability_policies"
) b
WHERE a.id = b.id AND b.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_policies_system" ON "capability_policies" USING btree ("capability_type","capability_key") WHERE scope = 'system';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_policies_user" ON "capability_policies" USING btree ("user_id","capability_type","capability_key") WHERE scope = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capability_policies_project" ON "capability_policies" USING btree ("project_id","capability_type","capability_key") WHERE scope = 'project';--> statement-breakpoint
ALTER TABLE "capability_policies" ADD CONSTRAINT "ck_capability_policies_subject" CHECK (
    (scope = 'system' and user_id is null and project_id is null) or
    (scope = 'user' and user_id is not null and project_id is null) or
    (scope = 'project' and project_id is not null and user_id is null)
  );