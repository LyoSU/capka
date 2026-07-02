CREATE TABLE "pending_elicitation" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"form" jsonb NOT NULL,
	"answer" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_pending_elicitation_message" ON "pending_elicitation" USING btree ("message_id");