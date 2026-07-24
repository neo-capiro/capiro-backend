-- A node's specific outreach/workspace target (a person/office), distinct from
-- `subject` (which is only a category: member/committee/agency/...). Snapshot
-- of a ClientTarget picked in apps/api at assignment time (memberId/memberName/
-- party/chamber/state/committee/sourceDirectory/clientTargetId) so staging can
-- resolve a REAL recipient instead of the bare subject label. No cross-schema
-- FK (ClientTarget lives in apps/api's database/schema) — bare id-ref snapshot,
-- same idiom as clientId/ownerUserId. Additive + nullable (most nodes have no
-- target; only member/committee/agency-subject nodes use this).
ALTER TABLE "sp_node" ADD COLUMN "target_ref" JSONB;

-- Rollback (forward-only migrate; documented per plan):
--   ALTER TABLE "sp_node" DROP COLUMN "target_ref";
