CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"relation" text DEFAULT 'supports' NOT NULL,
	"fragment_id" text,
	"message_id" text,
	"quote_snapshot" text,
	"locator_snapshot" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "knowledge_fragments" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"language" text,
	"locator" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_source_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"sha256" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"parser" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"representations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'ingesting' NOT NULL,
	"error" text,
	"superseded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"title" text NOT NULL,
	"origin" jsonb NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"space_id" text NOT NULL,
	"origin_message_id" text,
	"statement" text NOT NULL,
	"slot_key" text,
	"value" jsonb,
	"provenance" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"policy_state" text NOT NULL,
	"claim_id" text,
	"conflicts_with" text,
	"created_at" timestamp DEFAULT now(),
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "message_citations" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"source_version_id" text NOT NULL,
	"fragment_id" text NOT NULL,
	"quote_snapshot" text NOT NULL,
	"locator_snapshot" jsonb NOT NULL,
	"title_snapshot" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "note_claims" (
	"note_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"ref_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "vault_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"statement" text NOT NULL,
	"slot_key" text,
	"value" jsonb,
	"kind" text DEFAULT 'fact' NOT NULL,
	"origin" jsonb NOT NULL,
	"review_status" text DEFAULT 'unverified' NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp,
	"valid_to" timestamp,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"supersedes" text,
	"superseded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "vault_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "memory_docs" ADD COLUMN "migrated_at" timestamp;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_vault_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."vault_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_fragment_id_knowledge_fragments_id_fk" FOREIGN KEY ("fragment_id") REFERENCES "public"."knowledge_fragments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_fragments" ADD CONSTRAINT "knowledge_fragments_version_id_knowledge_source_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source_versions" ADD CONSTRAINT "knowledge_source_versions_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_citations" ADD CONSTRAINT "message_citations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_citations" ADD CONSTRAINT "message_citations_source_version_id_knowledge_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."knowledge_source_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_citations" ADD CONSTRAINT "message_citations_fragment_id_knowledge_fragments_id_fk" FOREIGN KEY ("fragment_id") REFERENCES "public"."knowledge_fragments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_claims" ADD CONSTRAINT "note_claims_note_id_vault_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."vault_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_claims" ADD CONSTRAINT "note_claims_claim_id_vault_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."vault_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD CONSTRAINT "vault_claims_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_notes" ADD CONSTRAINT "vault_notes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_space_created" ON "audit_events" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_cev_claim" ON "claim_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kfrag_version_ordinal" ON "knowledge_fragments" USING btree ("version_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_ksv_source" ON "knowledge_source_versions" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_ksv_source_sha" ON "knowledge_source_versions" USING btree ("source_id","sha256");--> statement-breakpoint
CREATE INDEX "idx_ksources_space" ON "knowledge_sources" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mcand_idem" ON "memory_candidates" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_mcand_unresolved" ON "memory_candidates" USING btree ("space_id") WHERE "memory_candidates"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mcit_msg_ordinal" ON "message_citations" USING btree ("message_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_mcit_fragment" ON "message_citations" USING btree ("fragment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_note_claims" ON "note_claims" USING btree ("note_id","claim_id");--> statement-breakpoint
CREATE INDEX "idx_note_claims_claim" ON "note_claims" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_spaces_type_ref" ON "spaces" USING btree ("type","ref_id");--> statement-breakpoint
CREATE INDEX "idx_spaces_owner" ON "spaces" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_vclaims_space_head" ON "vault_claims" USING btree ("space_id","superseded_at");--> statement-breakpoint
CREATE INDEX "idx_vclaims_supersedes" ON "vault_claims" USING btree ("supersedes");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vclaims_active_slot" ON "vault_claims" USING btree ("space_id","slot_key") WHERE "vault_claims"."superseded_at" IS NULL AND "vault_claims"."slot_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vclaims_one_successor" ON "vault_claims" USING btree ("supersedes") WHERE "vault_claims"."supersedes" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_vnotes_space" ON "vault_notes" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vnotes_memory_topic" ON "vault_notes" USING btree ("space_id","title") WHERE "vault_notes"."kind" = 'memory_topic';