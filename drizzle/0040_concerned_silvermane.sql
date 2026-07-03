CREATE TABLE "attached_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"host_path" text,
	"read_only" boolean DEFAULT true NOT NULL,
	"state" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "attached_folders" ADD CONSTRAINT "attached_folders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attached_folders_session_name" ON "attached_folders" USING btree ("session_key","name");--> statement-breakpoint
CREATE INDEX "idx_attached_folders_session" ON "attached_folders" USING btree ("session_key");