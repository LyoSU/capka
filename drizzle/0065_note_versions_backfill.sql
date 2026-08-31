CREATE TABLE "note_version_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"note_version_id" text NOT NULL,
	"block_ordinal" integer NOT NULL,
	"fragment_id" text,
	"message_id" text,
	"quote_snapshot" text,
	"locator_snapshot" jsonb,
	"relation" text DEFAULT 'supports' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "vault_note_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"source_class" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"prompt_access" text GENERATED ALWAYS AS (case when sensitive then 'owner_only'
               when source_class in ('legacy_confirmed','owner_authored','user_direct') then 'manifest'
               when source_class = 'agent_inferred' then 'memory_search'
               else 'knowledge_search' end) STORED NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_task_id" text,
	"stale_since" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_vnote_versions_source_class" CHECK ("vault_note_versions"."source_class" in ('legacy_confirmed','owner_authored','user_direct','agent_inferred','untrusted_derived'))
);
--> statement-breakpoint
ALTER TABLE "vault_notes" ADD COLUMN "current_version_id" text;--> statement-breakpoint
ALTER TABLE "vault_notes" ADD COLUMN "current_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "note_version_evidence" ADD CONSTRAINT "note_version_evidence_note_version_id_vault_note_versions_id_fk" FOREIGN KEY ("note_version_id") REFERENCES "public"."vault_note_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_version_evidence" ADD CONSTRAINT "note_version_evidence_fragment_id_knowledge_fragments_id_fk" FOREIGN KEY ("fragment_id") REFERENCES "public"."knowledge_fragments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_note_versions" ADD CONSTRAINT "vault_note_versions_note_id_vault_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."vault_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_nve_version" ON "note_version_evidence" USING btree ("note_version_id");--> statement-breakpoint
CREATE INDEX "idx_nve_fragment" ON "note_version_evidence" USING btree ("fragment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vnote_versions_rev" ON "vault_note_versions" USING btree ("note_id","revision");--> statement-breakpoint
ALTER TABLE "vault_notes" ADD CONSTRAINT "vault_notes_current_version_id_vault_note_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."vault_note_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Every existing note gets revision 1 and its pointer, in ONE step.
--
-- `owner_authored`: every note that exists today was created by `getOrCreateTopicNote` or
-- by the person, and neither is an agent conclusion. `provenance` records that.
INSERT INTO vault_note_versions
  (id, note_id, revision, title, body_markdown, source_class, sensitive, provenance, created_at)
SELECT md5(random()::text || n.id), n.id, 1, n.title, coalesce(n.body, ''), 'owner_authored', false,
       jsonb_build_object('kind', 'backfill_revision_1'), coalesce(n.created_at, now())
  FROM vault_notes n
 WHERE NOT EXISTS (SELECT 1 FROM vault_note_versions v WHERE v.note_id = n.id AND v.revision = 1);
--> statement-breakpoint
UPDATE vault_notes n
   SET current_version_id = v.id, current_revision = 1
  FROM vault_note_versions v
 WHERE v.note_id = n.id AND v.revision = 1 AND n.current_version_id IS NULL;
--> statement-breakpoint
-- THE BACKFILL-COMPLETENESS ASSERTION, and it replaces the `SET NOT NULL` an earlier draft
-- put here (Ruling 4). The parity control needs a bad backfill to FAIL THE MIGRATION rather
-- than to produce an empty `Topics:` block that the manifest comparison would read as a
-- legitimate change. A NOT NULL column would deliver that once and then make every
-- steady-state writer illegal, because `vault_note_versions.note_id` forces the note row
-- to exist before its first version does and Postgres checks NOT NULL before the insert
-- that would satisfy it. This fires at exactly the moment the guarantee is about, and
-- never again.
--
-- THE WHOLE FILE RUNS AS ONE TRANSACTION (drizzle's Postgres migrator wraps the pending
-- migrations in a single `session.transaction`), and the `ALTER TABLE vault_notes ADD
-- COLUMN` above takes ACCESS EXCLUSIVE on `vault_notes` and holds it to commit — so no
-- other session can commit a note between the UPDATE and this block, and the check cannot
-- fire on a row that arrived meanwhile.
--
-- IF THIS EXCEPTION EVER FIRES: boot aborts, the transaction rolls back whole, and the
-- migration retries on the next start. Nothing is half-written and no data is damaged.
-- The message means "the backfill genuinely missed a note", NEVER "you have lost
-- something".
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM vault_notes WHERE current_version_id IS NULL) THEN
    RAISE EXCEPTION 'backfill left % notes without a revision 1',
      (SELECT count(*) FROM vault_notes WHERE current_version_id IS NULL);
  END IF;
END $$;
