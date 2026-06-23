CREATE TABLE "plugin_files" (
	"id" text PRIMARY KEY NOT NULL,
	"install_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_files" ADD CONSTRAINT "plugin_files_install_id_plugin_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."plugin_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plugin_files_install_id" ON "plugin_files" USING btree ("install_id");