CREATE TABLE "message_effects" (
	"message_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"producer_task_id" text,
	"tool_name" text NOT NULL,
	"input" jsonb,
	"failed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "message_effects_message_id_tool_call_id_pk" PRIMARY KEY("message_id","tool_call_id")
);
--> statement-breakpoint
ALTER TABLE "message_effects" ADD CONSTRAINT "message_effects_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;