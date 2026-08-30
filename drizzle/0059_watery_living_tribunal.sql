CREATE TABLE "vault_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"relation" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" jsonb NOT NULL,
	"origin_message_id" text,
	"origin_fragment_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "ck_vault_edges_not_self" CHECK ("vault_edges"."from_node_id" <> "vault_edges"."to_node_id"),
	CONSTRAINT "ck_vault_edges_relation" CHECK ("vault_edges"."relation" in ('contains','references','derived_from'))
);
--> statement-breakpoint
CREATE TABLE "vault_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"kind" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "ck_vault_nodes_kind" CHECK ("vault_nodes"."kind" in ('note','claim','source'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vault_nodes_space_id" ON "vault_nodes" USING btree ("space_id","id");--> statement-breakpoint
ALTER TABLE "vault_edges" ADD CONSTRAINT "vault_edges_from_node_fk" FOREIGN KEY ("space_id","from_node_id") REFERENCES "public"."vault_nodes"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_edges" ADD CONSTRAINT "vault_edges_to_node_fk" FOREIGN KEY ("space_id","to_node_id") REFERENCES "public"."vault_nodes"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_nodes" ADD CONSTRAINT "vault_nodes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_live_vault_edge" ON "vault_edges" USING btree ("space_id","from_node_id","to_node_id","relation") WHERE "vault_edges"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vault_edges_from" ON "vault_edges" USING btree ("space_id","from_node_id") WHERE "vault_edges"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vault_edges_to" ON "vault_edges" USING btree ("space_id","to_node_id") WHERE "vault_edges"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vault_nodes_space_kind" ON "vault_nodes" USING btree ("space_id","kind") WHERE "vault_nodes"."deleted_at" IS NULL;