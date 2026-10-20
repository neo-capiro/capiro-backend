-- Source-only handoff for the sole shipping owner; not executed here.
-- Owner: Workspace13; source head91399fe1a205e37073cbeed2d7eb66a1fafd7fa2.
-- Use only the owner's existing authorized authoritative DB connection.
-- Replace __VERIFIED_LEDGER_SCHEMA__ only after discover-ledger.sql and
-- service DATABASE_URL schema/target verification. Never infer public/shared DB.
-- Preserve all output/error rows. No business tables or raw failure logs.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

SELECT
  transaction_timestamp() AS checked_at,
  current_database() AS database_name,
  current_user AS database_role,
  current_schema() AS current_schema_name,
  current_setting('search_path') AS search_path,
  current_setting('transaction_read_only') AS transaction_read_only,
  pg_is_in_recovery() AS is_replica;

-- Full-ledger blockers apply even when outside the selected additions.
SELECT
  count(*) AS total_attempts,
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
    AS finished_active_attempts,
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)
    AS unfinished_active_attempts,
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NOT NULL)
    AS inconsistent_timestamp_attempts,
  max(migration_name COLLATE "C")
    FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
    AS lexical_finished_frontier
FROM "__VERIFIED_LEDGER_SCHEMA__"."_prisma_migrations";

SELECT
  id, migration_name, checksum, started_at, finished_at, rolled_back_at,
  applied_steps_count,
  (NULLIF(btrim(logs), '') IS NOT NULL) AS logs_present
FROM "__VERIFIED_LEDGER_SCHEMA__"."_prisma_migrations"
WHERE (finished_at IS NULL AND rolled_back_at IS NULL)
   OR (finished_at IS NOT NULL AND rolled_back_at IS NOT NULL)
ORDER BY started_at, migration_name COLLATE "C", id;

-- Duplicate successful attempts are retained as ambiguity, never deduplicated.
SELECT migration_name, count(*) AS finished_active_attempts
FROM "__VERIFIED_LEDGER_SCHEMA__"."_prisma_migrations"
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
GROUP BY migration_name
HAVING count(*) > 1
ORDER BY migration_name COLLATE "C";

-- Every exact-name, engine-compatible checksum or suffix candidate is retained.
-- A suffix match is a discovery candidate, NOT proof of equivalent SQL.
WITH expected(source_name, source_sha256, slug, accepted_checksums) AS (
VALUES
  ('20261006210000_workspace_newsletters', '2b094e84eb8912c0001b07468307b156806f2f0cb2da5475d93b8ab95aa27f15', 'workspace_newsletters', ARRAY['2b094e84eb8912c0001b07468307b156806f2f0cb2da5475d93b8ab95aa27f15', '2b94e84eb8912c001b746837b156806f2fcb2da5475d93b8ab95aa27f15', 'c68882189dd3f480bfb883c91b605c0d99fccc648b4d539b08456bef18ce5d5a', 'c68882189dd3f480bfb883c91b605cd99fccc648b4d539b8456bef18ce5d5a']::text[]),
  ('20261007020000_newsletter_review', '668a11dcc44d064d00391b2eb0bcafe58439b24e881d81003006f8ae360b52d6', 'newsletter_review', ARRAY['668a11dcc44d064d00391b2eb0bcafe58439b24e881d81003006f8ae360b52d6', '668a11dcc44d64d0391b2eb0bcafe58439b24e881d810306f8ae36b52d6', 'd294629b3074fec9912e10fab5df12c945f2e1c565d8a12b0a1717237fcf15ed', 'd294629b3074fec9912e10fab5df12c945f2e1c565d8a12ba1717237fcf15ed']::text[]),
  ('20261007030000_newsletter_brand_kit', 'efa87b12853b5fc9da4142cbd7534c593b75a505b0c24c2be09aa541bc27e85c', 'newsletter_brand_kit', ARRAY['efa87b12853b5fc9da4142cbd7534c593b75a505b0c24c2be09aa541bc27e85c', 'efa87b12853b5fc9da4142cbd7534c593b75a55b0c24c2be09aa541bc27e85c', 'd46d189f99a3dd75b9f11060ca6ce5159c94d4f2368fd75d2872355a17b9dc8d']::text[]),
  ('20261007040000_newsletter_asset_library_deletion', '256490ed5730926a529f8016f1cfdc9099790e520b8c0cc53b428e577fca7c50', 'newsletter_asset_library_deletion', ARRAY['256490ed5730926a529f8016f1cfdc9099790e520b8c0cc53b428e577fca7c50', '256490ed5730926a529f8016f1cfdc909979e52b8ccc53b428e577fca7c50', '1c02d2d371c760e13cff70e5fed2edda437e96b562b937099457adef29cd26b6', '1c2d2d371c760e13cff70e5fed2edda437e96b562b93799457adef29cd26b6']::text[]),
  ('20261007050000_newsletter_asset_folders', '3c5c21d1678b4b2e33b073f1aeeba84ae1df4648bc7cdfd7c4749114d427b134', 'newsletter_asset_folders', ARRAY['3c5c21d1678b4b2e33b073f1aeeba84ae1df4648bc7cdfd7c4749114d427b134', 'f575f53b4d478aca841042d63a4e53ad50b96319a087784cdad577866b5fdce9']::text[]),
  ('20261007060000_newsletter_image_revisions', '0d7553bfed297caf6c80cb46add65ba1fe97af9c0c178c95a7d4178cebf0718c', 'newsletter_image_revisions', ARRAY['0d7553bfed297caf6c80cb46add65ba1fe97af9c0c178c95a7d4178cebf0718c', 'd7553bfed297caf6c80cb46add65ba1fe97af9cc178c95a7d4178cebf0718c', 'b3e140b1dbbff05b8a252a6c2666b427f34688ac09ede454d8943fb0328e5c9e', 'b3e140b1dbbff05b8a252a6c2666b427f34688ac9ede454d8943fb0328e5c9e']::text[]),
  ('20261007070000_newsletter_thread_email', 'af4e0632d5cfa3c2ce69c3b664c82df5d0b24b6248997589f254933f2bb42b45', 'newsletter_thread_email', ARRAY['af4e0632d5cfa3c2ce69c3b664c82df5d0b24b6248997589f254933f2bb42b45', 'af4e632d5cfa3c2ce69c3b664c82df5d0b24b6248997589f254933f2bb42b45', 'fc611a31337597dc92127e726245365df2cce9311b108956128d9ee21fbd4b72']::text[]),
  ('20261007080000_newsletter_author_access', '381a3b645c192f2e1f8ddd754876497e52a4a321aefabd6707f4439acb0ef2ea', 'newsletter_author_access', ARRAY['381a3b645c192f2e1f8ddd754876497e52a4a321aefabd6707f4439acb0ef2ea', '381a3b645c192f2e1f8ddd754876497e52a4a321aefabd677f4439acbef2ea', 'e2f0d151442a9020634fc379bd701da5969f5dab51aacb139cdc1c4d1e18044c', 'e2f0d151442a9020634fc379bd701da5969f5dab51aacb139cdc1c4d1e1844c']::text[]),
  ('20261007090000_newsletter_email_invitations', 'f33ed9f54c464c53c0440be1e2025c67ec20872e5e1cfef2d77b1f9c2f58cedb', 'newsletter_email_invitations', ARRAY['f33ed9f54c464c53c0440be1e2025c67ec20872e5e1cfef2d77b1f9c2f58cedb', 'f33ed9f54c464c53c044be1e225c67ec20872e5e1cfef2d77b1f9c2f58cedb', 'd00892082a43751774bee9995114a62c90c6955bc2132917e8a629e8b0a8531e', 'd089282a43751774bee9995114a62c90c6955bc2132917e8a629e8b0a8531e']::text[]),
  ('20261007100000_newsletter_account_role', '02e1905c401323c8bbaaf0c443d667e76bb08e854e9c2d9e82c0468125337719', 'newsletter_account_role', ARRAY['02e1905c401323c8bbaaf0c443d667e76bb08e854e9c2d9e82c0468125337719', '2e1905c401323c8bbaaf0c443d667e76bb08e854e9c2d9e82c0468125337719', '8d3f9c66f902d8ca9d38835c5a09dd8d305c81881e11b1ed9633a7b1b642bbed', '8d3f9c66f92d8ca9d38835c5a9dd8d305c81881e11b1ed9633a7b1b642bbed']::text[]),
  ('20261012030000_prospect_resource_origin', '2ea8c04127567b1d1a0aea936cc25f6c56714655b19655fa5faacb9420139788', 'prospect_resource_origin', ARRAY['2ea8c04127567b1d1a0aea936cc25f6c56714655b19655fa5faacb9420139788', '2ea8c04127567b1d1aaea936cc25f6c56714655b19655fa5faacb9420139788', 'a04e7e1235d260b1ea2d8d569167189365d664079cc8af896e493f90e84ad905', 'a04e7e1235d260b1ea2d8d569167189365d66479cc8af896e493f90e84ad95']::text[]),
  ('20261012040000_saved_version_immutability', 'a00d85df4d7cc55e7e637593c8ad75688c850ff765ff8f4121cca7c716ed29c4', 'saved_version_immutability', ARRAY['a00d85df4d7cc55e7e637593c8ad75688c850ff765ff8f4121cca7c716ed29c4', 'a0d85df4d7cc55e7e637593c8ad75688c85ff765ff8f4121cca7c716ed29c4', '8ea13684ae298465cbb67e2c73647079aac6ca550b11e394d6cf3c95668f3cd1', '8ea13684ae298465cbb67e2c73647079aac6ca55b11e394d6cf3c95668f3cd1']::text[]),
  ('20261013090000_prospect_brief_workspace_copy', '01a8adc4a151fe29da5b68f4e55c9d6b3c37b2b22a5caa79f272020113f45d2a', 'prospect_brief_workspace_copy', ARRAY['01a8adc4a151fe29da5b68f4e55c9d6b3c37b2b22a5caa79f272020113f45d2a', '1a8adc4a151fe29da5b68f4e55c9d6b3c37b2b22a5caa79f2722113f45d2a', '2b820bdc86175be500243bba75e1497e3fccd0c23f6eacb962d87a7e7f20de8b', '2b82bdc86175be50243bba75e1497e3fccd0c23f6eacb962d87a7e7f20de8b']::text[])
)
SELECT
  e.source_name, e.source_sha256,
  m.id AS attempt_id, m.migration_name AS recorded_name,
  m.checksum AS recorded_checksum,
  (m.migration_name = e.source_name) AS exact_name,
  (m.checksum = e.source_sha256) AS exact_source_checksum,
  (m.checksum = ANY(e.accepted_checksums)) AS engine_compatible_source_checksum,
  (right(m.migration_name, length(e.slug) + 1) = '_' || e.slug) AS suffix_candidate,
  m.started_at, m.finished_at, m.rolled_back_at, m.applied_steps_count,
  (NULLIF(btrim(m.logs), '') IS NOT NULL) AS logs_present,
  CASE
    WHEN m.id IS NULL THEN 'no_matching_record'
    WHEN m.finished_at IS NOT NULL AND m.rolled_back_at IS NOT NULL
      THEN 'inconsistent_timestamps'
    WHEN m.rolled_back_at IS NOT NULL THEN 'rolled_back_record'
    WHEN m.finished_at IS NOT NULL THEN 'finished_record'
    ELSE 'unfinished_or_failed_record'
  END AS record_state
FROM expected e
LEFT JOIN "__VERIFIED_LEDGER_SCHEMA__"."_prisma_migrations" m
  ON m.migration_name = e.source_name
  OR m.checksum = ANY(e.accepted_checksums)
  OR right(m.migration_name, length(e.slug) + 1) = '_' || e.slug
ORDER BY e.source_name COLLATE "C", m.started_at, m.id;

ROLLBACK;
