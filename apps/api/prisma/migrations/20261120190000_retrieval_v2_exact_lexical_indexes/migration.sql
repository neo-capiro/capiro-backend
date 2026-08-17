-- Knowledge Plane Phase 11: exact/lexical retrieval indexes.
--
-- This migration deliberately creates NO search table, materialized search
-- copy, entity dictionary, vector store, or denormalized retrieval ledger.
-- Exact retrieval continues to read canonical identity and authoritative live
-- domain tables directly. Existing PK/unique/index coverage is reused wherever
-- it already matches the query shape.

-- Canonical identity: Phase 5 already owns alias and identifier exact indexes.
-- These name-first indexes support exact canonical-name lookup without forcing
-- callers to know entity_type in advance.
CREATE INDEX IF NOT EXISTS canonical_entities_global_exact_name_idx
  ON canonical_entities (normalized_name, entity_type, id)
  WHERE identity_scope = 'global_public' AND tenant_id IS NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS canonical_entities_tenant_exact_name_idx
  ON canonical_entities (tenant_id, normalized_name, entity_type, id)
  WHERE identity_scope = 'tenant_private' AND tenant_id IS NOT NULL AND status = 'active';

-- Tenant CRM: exact UEI/CAGE lookup still flows through the existing client
-- ethical-wall visibility check; these indexes do not weaken that boundary.
CREATE INDEX IF NOT EXISTS clients_tenant_uei_exact_idx
  ON clients (tenant_id, uei, id)
  WHERE uei IS NOT NULL;

CREATE INDEX IF NOT EXISTS clients_tenant_cage_exact_idx
  ON clients (tenant_id, cage_code, id)
  WHERE cage_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS client_capabilities_appropriation_exact_idx
  ON client_capabilities (tenant_id, appropriation_account, client_id, id)
  WHERE appropriation_account IS NOT NULL;

-- Federal awards: PE already has an existing index. The source's raw
-- award_unique_id is UNIQUE, but Retrieval V2 normalizes government IDs to
-- uppercase/no-whitespace before comparing, so mirror that exact expression.
CREATE INDEX IF NOT EXISTS federal_award_award_unique_exact_idx
  ON federal_award (upper(regexp_replace(btrim(award_unique_id), '[[:space:]]+', '', 'g')), id);

CREATE INDEX IF NOT EXISTS federal_award_piid_exact_idx
  ON federal_award (upper(regexp_replace(btrim(piid), '[[:space:]]+', '', 'g')), id)
  WHERE piid IS NOT NULL;

CREATE INDEX IF NOT EXISTS federal_award_fain_exact_idx
  ON federal_award (upper(regexp_replace(btrim(fain), '[[:space:]]+', '', 'g')), id)
  WHERE fain IS NOT NULL;

CREATE INDEX IF NOT EXISTS federal_award_recipient_uei_exact_idx
  ON federal_award (upper(regexp_replace(btrim(recipient_uei), '[[:space:]-]+', '', 'g')), id)
  WHERE recipient_uei IS NOT NULL;

-- SAM notice_id is already UNIQUE and solicitation_number already has a raw
-- B-tree index. These functional siblings match Phase 11's exact identifier
-- normalization without replacing those live product-path indexes.
CREATE INDEX IF NOT EXISTS sam_opportunity_notice_exact_idx
  ON sam_opportunity (upper(regexp_replace(btrim(notice_id), '[[:space:]]+', '', 'g')), id);

CREATE INDEX IF NOT EXISTS sam_opportunity_solicitation_exact_idx
  ON sam_opportunity (upper(regexp_replace(btrim(solicitation_number), '[[:space:]]+', '', 'g')), id)
  WHERE solicitation_number IS NOT NULL;

-- Congress bill id itself is the PK. This supports exact display-form lookups
-- such as H.R. 8800 where congress may be an explicit disambiguator.
CREATE INDEX IF NOT EXISTS congress_bill_type_number_congress_exact_idx
  ON congress_bill (bill_type, bill_number, congress DESC, id);

-- ProgramAlias already has a B-tree exact alias_normalized index plus trigram
-- GIN. Add only the missing canonical program-name exact expression. The
-- expression mirrors ProgramsService's alias normalization (uppercase,
-- punctuation collapsed to one space, trim).
CREATE INDEX IF NOT EXISTS program_canonical_name_exact_idx
  ON program (
    btrim(upper(regexp_replace(btrim(canonical_name), '[^[:alnum:]]+', ' ', 'g'))),
    id
  )
  WHERE status = 'active';

-- SEC source lookup normalizes CIK to the same ten-digit representation as the
-- shared entity normalizer. Keep the source table authoritative.
CREATE INDEX IF NOT EXISTS sec_filing_normalized_cik_exact_idx
  ON sec_filing (lpad(regexp_replace(cik, '\D', '', 'g'), 10, '0'), filing_date DESC, accession_number DESC);
