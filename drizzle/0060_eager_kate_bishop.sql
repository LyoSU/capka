INSERT INTO "vault_nodes" (id, space_id, kind, created_at)
  SELECT id, space_id, 'claim',  recorded_at FROM "vault_claims"
  UNION ALL SELECT id, space_id, 'note',   COALESCE(created_at, now()) FROM "vault_notes"
  UNION ALL SELECT id, space_id, 'source', COALESCE(created_at, now()) FROM "knowledge_sources"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_source_node_fk" FOREIGN KEY ("space_id","id") REFERENCES "public"."vault_nodes"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_claims" ADD CONSTRAINT "vault_claim_node_fk" FOREIGN KEY ("space_id","id") REFERENCES "public"."vault_nodes"("space_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_notes" ADD CONSTRAINT "vault_note_node_fk" FOREIGN KEY ("space_id","id") REFERENCES "public"."vault_nodes"("space_id","id") ON DELETE no action ON UPDATE no action;
