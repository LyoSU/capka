-- Back-fill a `contains` edge for every topic membership that already exists.
--
-- Spec §11.5 orders the three steps: BACKFILL, then dual-write for a full release with a
-- parity check, then switch reads to the edges. Without this step the dual-write starts
-- from an empty edge table beside a populated `note_claims`, so `containsParity` reports a
-- divergence for every fact anyone had already filed — and in dev it does not merely
-- report: `assertContainsParity` throws inside the writer's transaction, so the first
-- memory write into a space with any history at all would fail. A control that fires on
-- the state it was deployed into cannot tell anyone anything.
--
-- Mirrors `linkNodes` exactly: `note_claims.position` carries over, and the actor is
-- `system` because a migration is not a person — the edges this writes were nobody's act,
-- and naming a user on them would put an author on the graph the audit log cannot
-- corroborate.
--
-- Soft-deleted nodes are skipped on BOTH sides. `forgetClaim` keeps the `note_claims` row
-- while `deleteNode` closes the edges, so a forgotten fact legitimately has a membership
-- row and no live edge; minting one here would resurrect the link in the graph for a claim
-- every reader hides. This is the same scope `containsParity` compares on, which is what
-- makes the backfill and the control agree by construction rather than by coincidence.
--
-- `fn.space_id` is the source of the edge's space and `tn` is joined on it: the composite
-- FKs would refuse a cross-space pair anyway, and joining on the space here means such a
-- row is skipped rather than aborting the whole migration.
--
-- `ON CONFLICT DO NOTHING` makes a re-drive a no-op against `uniq_live_vault_edge`.
INSERT INTO "vault_edges" (id, space_id, from_node_id, to_node_id, relation, position, created_by)
  SELECT md5(random()::text || nc.note_id || nc.claim_id), fn.space_id, nc.note_id, nc.claim_id,
         'contains', nc.position, '{"kind":"system"}'::jsonb
  FROM "note_claims" nc
  JOIN "vault_nodes" fn ON fn.id = nc.note_id  AND fn.deleted_at IS NULL
  JOIN "vault_nodes" tn ON tn.id = nc.claim_id AND tn.space_id = fn.space_id AND tn.deleted_at IS NULL
ON CONFLICT DO NOTHING;
