ALTER TABLE "plugin_installs" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "plugin_installs" ADD CONSTRAINT "plugin_installs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plugin_installs_user" ON "plugin_installs" USING btree ("user_id");