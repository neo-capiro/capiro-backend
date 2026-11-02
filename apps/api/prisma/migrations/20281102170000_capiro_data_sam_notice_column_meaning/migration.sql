-- query_capiro_data / describe_capiro_data: correct three column meanings of
-- meri_public.sam_opportunities (20281102140000, immutable once applied).
--
-- The current SAM notice writer, the Tango funding catalog
-- (funding-catalog.mapper.ts noticeFields, funding-catalog.store.ts), never sets
-- base_type or archive_date, and it stores the provider's own active flag as
-- reported at synchronization; nothing derives active from archive_date. Values
-- in base_type and archive_date can exist only on notices an earlier SAM.gov
-- writer loaded. The published comments said otherwise; this migration replaces
-- the view comment and the three column comments. Comments only: no view
-- definition, grant, policy, role or row changes.
SET ROLE capiro_public_projection_owner;

COMMENT ON VIEW meri_public.sam_opportunities IS '{"description":"SAM.gov contract opportunity notices as synchronized by Capiro, one row per notice: solicitations, presolicitations, sources sought, special and award notices. Open for responses means active and response_deadline null or not yet passed.","grain":"One row per (notice_id), the SAM.gov notice id.","primaryKey":["notice_id"],"relationships":[],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Only the notices Capiro synchronized; a missing notice is absence within this ingestion, not on SAM.gov.","active is the provider''s flag at synchronization and can be true after the response window has closed; also test response_deadline.","notice_type is the current type after amendments and is truncated to 32 characters. Award Notice rows announce awards, not open competitions.","base_type and archive_date are null on every notice the current writer loads; a value appears only on notices from an earlier writer, so never filter or count by them.","pop_state is null when the notice did not state a two-letter place-of-performance state."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.sam_opportunities.base_type IS '{"description":"The notice''s original SAM.gov type before amendments, recorded only by an earlier writer; null on every notice the current writer loads, so null does not mean the type never changed. Use notice_type."}';
COMMENT ON COLUMN meri_public.sam_opportunities.archive_date IS '{"description":"SAM.gov archive date (UTC), recorded only by an earlier writer; null on every notice the current writer loads, so null does not mean the notice never archives. Use active and response_deadline."}';
COMMENT ON COLUMN meri_public.sam_opportunities.active IS '{"description":"The provider''s active flag as reported at synchronization; it is not computed from archive_date and does not describe the response window: an active notice can be past its response_deadline.","nullable":false}';

RESET ROLE;
