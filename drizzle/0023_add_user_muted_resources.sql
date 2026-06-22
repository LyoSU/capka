CREATE TABLE "user_muted_resources" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	CONSTRAINT "user_muted_resources_user_id_kind_resource_id_pk" PRIMARY KEY("user_id","kind","resource_id")
);
--> statement-breakpoint
ALTER TABLE "user_muted_resources" ADD CONSTRAINT "user_muted_resources_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_muted_user" ON "user_muted_resources" USING btree ("user_id");