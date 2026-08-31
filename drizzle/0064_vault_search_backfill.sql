-- Back-fill `vault_search_documents` for every space that already exists.
--
-- The mapping mirrors `projectClaimDoc` / `projectNoteDoc` exactly, and the rebuild test
-- ("reproduces exactly what the writers wrote") is what proves the two agree: after this
-- applies, `rebuildSearchDocuments` on any space must reproduce the same rows.
--
-- There is no `includes()` fallback for an unindexed space, because there is no window in
-- which one exists: this runs inside the boot migration, before the app serves a request.
-- A fallback would have been a second search implementation plus a deletion date for it.
--
-- Soft-deleted nodes are skipped, and `ON CONFLICT DO NOTHING` makes a re-drive a no-op.
INSERT INTO "vault_search_documents" (id, space_id, node_id, kind, title, owner_text, model_text)
  SELECT md5(random()::text || c.id), c.space_id, c.id, 'claim', '',
         c.statement || COALESCE(' ' || c.slot_key, ''),
         CASE WHEN c.sensitive THEN NULL ELSE c.statement || COALESCE(' ' || c.slot_key, '') END
  FROM "vault_claims" c
  JOIN "vault_nodes" n ON n.id = c.id AND n.space_id = c.space_id
  WHERE n.deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "vault_search_documents" (id, space_id, node_id, kind, title, owner_text, model_text)
  SELECT md5(random()::text || v.id), v.space_id, v.id, 'note', v.title, v.body, v.body
  FROM "vault_notes" v
  JOIN "vault_nodes" n ON n.id = v.id AND n.space_id = v.space_id
  WHERE n.deleted_at IS NULL
ON CONFLICT DO NOTHING;
