ALTER TABLE "chats" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_share_token_unique" UNIQUE("share_token");