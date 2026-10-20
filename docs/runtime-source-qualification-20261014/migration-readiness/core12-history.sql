-- Source-only handoff for the sole shipping owner; not executed here.
-- Owner: Core12; source head91399fe1a205e37073cbeed2d7eb66a1fafd7fa2.
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
  ('20261007010000_newsletter_outreach_format', '20e1550263c32f39d49e5956c41e08af891aeb71b45c11b5d23e853074e51b07', 'newsletter_outreach_format', ARRAY['20e1550263c32f39d49e5956c41e08af891aeb71b45c11b5d23e853074e51b07', '20e155263c32f39d49e5956c41e8af891aeb71b45c11b5d23e853074e51b7', '7ec7f6d4dbdf9e718aafab4f6f6187161c85da7e0385e59e95965f23a50fccf6', '7ec7f6d4dbdf9e718aafab4f6f6187161c85da7e385e59e95965f23a5fccf6']::text[]),
  ('20261007020000_newsletter_review_email_delivery', '0b1f4a2f560a983afff2483167c2a99ebc9a6430acab81fec72cb483b0b17c3b', 'newsletter_review_email_delivery', ARRAY['0b1f4a2f560a983afff2483167c2a99ebc9a6430acab81fec72cb483b0b17c3b', 'b1f4a2f56a983afff2483167c2a99ebc9a6430acab81fec72cb483b0b17c3b', 'ca590570056e13552d693cafc5e97b80d076b9fb90ec6801487730ad33c30a26', 'ca5957056e13552d693cafc5e97b80d076b9fb90ec681487730ad33c3a26']::text[]),
  ('20261007030000_newsletter_invitation_email_delivery', '27242c9b201631547a48cf3d951b77355bc54a9a4b056a2bc5341f6cec18f066', 'newsletter_invitation_email_delivery', ARRAY['27242c9b201631547a48cf3d951b77355bc54a9a4b056a2bc5341f6cec18f066', '27242c9b201631547a48cf3d951b77355bc54a9a4b56a2bc5341f6cec18f066', '558cb08decf56507371672935e3f4b35c0b1a4f76cd86adf8e1aa9aabee10b47', '558cb08decf5657371672935e3f4b35c0b1a4f76cd86adf8e1aa9aabee1b47']::text[]),
  ('20261007040000_newsletter_account_invitations', 'd9466d8bd25d3b719f9a64bd4224d03b125c3892fde98be6e57da3683cc58d07', 'newsletter_account_invitations', ARRAY['d9466d8bd25d3b719f9a64bd4224d03b125c3892fde98be6e57da3683cc58d07', 'd9466d8bd25d3b719f9a64bd4224d03b125c3892fde98be6e57da3683cc58d7', 'a95122d6b1ba8ca13af0646bc6b03e8a8faf67d4ecb81622cc0cca3486473326', 'a95122d6b1ba8ca13af0646bc6b03e8a8faf67d4ecb81622cccca3486473326']::text[]),
  ('20261014050000_user_portfolio_layout', '8058591c5b7e9bc32a215367c73064a74cf8b81da54985f95498e63ab7d3727f', 'user_portfolio_layout', ARRAY['8058591c5b7e9bc32a215367c73064a74cf8b81da54985f95498e63ab7d3727f', '7ccb4dbc851ddd33c9f6e198ea5b143891def95667effcd2f9d20f45fa86a22a', '7ccb4dbc851ddd33c9f6e198ea5b143891def95667effcd2f9d2f45fa86a22a']::text[]),
  ('20281011010000_client_objectives', 'cd6a1f08162b55b04325d7ef017fdabc23d1d28870fd1c6ce863789f70fca5e2', 'client_objectives', ARRAY['cd6a1f08162b55b04325d7ef017fdabc23d1d28870fd1c6ce863789f70fca5e2', 'cd6a1f8162b55b04325d7ef17fdabc23d1d28870fd1c6ce863789f70fca5e2', '9372173047c2f4cc6e4b43c74f2a78978849c56ca5902d3dc178b00be5c4984e', '9372173047c2f4cc6e4b43c74f2a78978849c56ca5902d3dc178b0be5c4984e']::text[]),
  ('20281011020000_portfolio_prospect_stages', 'fc3aeb539b0e75f2c1024346eb9b745ee185474e5ba4ed8ea3ff9a02da932f78', 'portfolio_prospect_stages', ARRAY['fc3aeb539b0e75f2c1024346eb9b745ee185474e5ba4ed8ea3ff9a02da932f78', 'fc3aeb539be75f2c124346eb9b745ee185474e5ba4ed8ea3ff9a2da932f78', '64bfa06d34943b5bc575e52510fa40dee9f6e1ad2c8a6eb4b5d0d26311a70ef6', '64bfa06d34943b5bc575e52510fa40dee9f6e1ad2c8a6eb4b5d0d26311a7ef6']::text[]),
  ('20281011030000_prospect_contacts', '473e30271d7f851582a5c74e201ce40b7b7dcb411ca5597fda9088b4c341d20d', 'prospect_contacts', ARRAY['473e30271d7f851582a5c74e201ce40b7b7dcb411ca5597fda9088b4c341d20d', '473e30271d7f851582a5c74e201ce4b7b7dcb411ca5597fda9088b4c341d2d', '4b9d299c8c5868c3c1560666976981e9dd01522ce5cc6d9618dc2327f4d6ef26', '4b9d299c8c5868c3c156666976981e9dd1522ce5cc6d9618dc2327f4d6ef26']::text[]),
  ('20281012010000_client_activity_commands', '4cd0fe0832a878c4c979ed6399037c3a32d29bde54929100bf7856916c656892', 'client_activity_commands', ARRAY['4cd0fe0832a878c4c979ed6399037c3a32d29bde54929100bf7856916c656892', '4cd0fe832a878c4c979ed639937c3a32d29bde5492910bf7856916c656892', 'bc46b73db4036de57b34a77a3da5084dda77bcd2cdee5778ed9f5deea883579a', 'bc46b73db436de57b34a77a3da584dda77bcd2cdee5778ed9f5deea883579a']::text[]),
  ('20281012020000_client_ordered_owners', 'ae7f4d3dd629854f450af63b006fbb173c0ff22b3f05f0add9e65df50393f8c4', 'client_ordered_owners', ARRAY['ae7f4d3dd629854f450af63b006fbb173c0ff22b3f05f0add9e65df50393f8c4', 'ae7f4d3dd629854f45af63b06fbb173cff22b3f5f0add9e65df5393f8c4', '734c0cd8432c4b7194991fe993fd24fd3b6f9924316447f3f8389eef75f570fe', '734ccd8432c4b7194991fe993fd24fd3b6f9924316447f3f8389eef75f570fe']::text[]),
  ('20281012030000_prospect_resource_origin', '0441a93ecd2c33bc86100e80aa13fbddf9e842da07c7d1bfd54037ada35f8052', 'prospect_resource_origin', ARRAY['0441a93ecd2c33bc86100e80aa13fbddf9e842da07c7d1bfd54037ada35f8052', '441a93ecd2c33bc8610e80aa13fbddf9e842da7c7d1bfd54037ada35f8052', '02a946caa1ddfd13ed568e7c24eb70b0eab7f11b4bd35a39568382a88fcd7277', '2a946caa1ddfd13ed568e7c24eb70b0eab7f11b4bd35a39568382a88fcd7277']::text[]),
  ('20281012060000_federal_register_effective_evidence', '8b6ca68bb4a7b56a553e3a4a7baf009eae05d58a70b2d1fd610c06fe318015f5', 'federal_register_effective_evidence', ARRAY['8b6ca68bb4a7b56a553e3a4a7baf009eae05d58a70b2d1fd610c06fe318015f5', '8b6ca68bb4a7b56a553e3a4a7baf09eae5d58a70b2d1fd61c6fe318015f5', 'bcf0e82b5f1976918738649c356e90dd0715b0caa8036604438acd486b6999d0', 'bcf0e82b5f1976918738649c356e90dd715b0caa83664438acd486b6999d0']::text[])
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
