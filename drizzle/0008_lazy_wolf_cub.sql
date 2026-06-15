CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"project_id" text,
	"name" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb,
	"secrets" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_user_id" ON "mcp_servers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_project_id" ON "mcp_servers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_scope" ON "mcp_servers" USING btree ("scope");