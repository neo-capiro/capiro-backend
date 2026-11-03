-- DIBBS/SBIR consolidated-source integration.
--
-- Additive and forward-only, one snapshot. Nothing is dropped, no row is
-- rewritten, no table is added.
--
-- 1) Durable walk checkpoints. Widens ONLY tango_sync_checkpoint's allowed
--    resource_type values so the DIBBS and SBIR walks can retain a resumable
--    page cursor and window between bounded runs, instead of restarting at
--    page 1 on every quota stop. Every existing value stays allowed, so applied
--    checkpoints (entity, opportunity, notice, forecast, vehicle,
--    vehicle_awardee, grant) are unaffected. Four distinct types, one per
--    table, because SBIR topics and solicitations may share a provider key and
--    must never collapse onto one checkpoint.
--
--    tango_resource_snapshot and tango_resource_link are deliberately NOT
--    widened: neither DIBBS nor SBIR writes a snapshot or a link, and admitting
--    a type there would let a walk begin writing a resource family this
--    program does not model.
--
-- 2) SBIR topic synopsis. The provider documents `description` on
--    /api/sbir/topics/ (verified 2026-11-03 against docs.makegov.com); the
--    earlier migration header claiming no documented description is stale.
--    Nullable and additive: existing rows keep NULL, and absence is never
--    backfilled from the title.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE tango_sync_checkpoint DROP CONSTRAINT tango_sync_checkpoint_resource_type_chk;
ALTER TABLE tango_sync_checkpoint ADD CONSTRAINT tango_sync_checkpoint_resource_type_chk
  CHECK (resource_type IN ('entity','opportunity','notice','forecast','vehicle','vehicle_awardee','grant',
    'dibbs_solicitation','sbir_topic','sbir_solicitation'));
ALTER TABLE tango_sbir_topic ADD COLUMN description text;
-- A cycle is identified by its provider `solicitation_id`; the public number is
-- documented as possibly empty for some DoD cycles. Dropping NOT NULL is what
-- lets that real shape be stored instead of dropped. The existing
-- tango_sbir_solicitation_number_chk forbidding an EMPTY string stays in force
-- and permits NULL (a NULL CHECK expression passes), so '' is still rejected
-- while "not stated" is representable.
ALTER TABLE tango_sbir_solicitation ALTER COLUMN solicitation_number DROP NOT NULL;
-- Embedding markers for the ACTIVE SBIR topic synopsis only. Additive and
-- nullable; the existing embed-funding-catalog writer already owns this
-- contract for grants and notices. No DIBBS title-only embeddings and no SBIR
-- cycle title-only embeddings.
ALTER TABLE tango_sbir_topic ADD COLUMN embedded_content_hash text, ADD COLUMN embedded_at timestamptz;
COMMIT;
