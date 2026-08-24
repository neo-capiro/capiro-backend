-- Direct private Capiro evidence -> Matter linking (closeout PR, product
-- spec section 8/14).
--
-- Current Matter linking (PR #1253) covers program_element, bill,
-- outcome_event, and finding -- plus records reach a Matter transitively
-- via client_advocacy_record.matter_id (LDA filings, client submissions,
-- private meeting/email candidates that Fill with Meri already turned into
-- a durable advocacy_record row). What's missing is DIRECT linking for
-- authoritative Capiro objects that should show up in a Matter's evidence
-- even when no advocacy_record row was ever created for them: meetings,
-- mail threads, Outreach records, and Strategy plan/nodes.
--
-- Every new link type stores ONLY a reference (id + safe denormalized
-- label/date fields in metadata_jsonb) -- never a raw transcript, mail
-- body, or Strategy execution content. The authoritative object itself
-- (meetings/mail_threads/outreach_records/sp_strategy) remains the source
-- of truth; this table is a pointer, matching the existing
-- program_element/bill/outcome_event/finding links.

ALTER TABLE client_advocacy_matter_link DROP CONSTRAINT IF EXISTS client_advocacy_matter_link_type_check;
ALTER TABLE client_advocacy_matter_link ADD CONSTRAINT client_advocacy_matter_link_type_check CHECK (link_type IN (
  'program_element', 'bill', 'outcome_event', 'finding',
  'meeting', 'mail_thread', 'outreach', 'strategy'
));

-- Section 14: "Every link must retain: source type, authoritative source
-- ID, relationship type, confidence, provenance/rationale where inferred."
-- link_type + link_key already cover source type + authoritative source
-- ID. The three new columns below cover the rest without disturbing any
-- existing row (all nullable/defaulted; the four PR #1253 link types never
-- populate them and keep working exactly as before).
ALTER TABLE client_advocacy_matter_link ADD COLUMN IF NOT EXISTS relationship_type VARCHAR(32) NULL;
ALTER TABLE client_advocacy_matter_link ADD COLUMN IF NOT EXISTS confidence NUMERIC(5,4) NULL
  CONSTRAINT client_advocacy_matter_link_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
ALTER TABLE client_advocacy_matter_link ADD COLUMN IF NOT EXISTS provenance TEXT NULL;

-- Section 8 Strategy: "Distinguish planned_action / completed_action. A
-- Strategy alone is not proof the activity occurred." Stored as a
-- constrained value on relationship_type for strategy links specifically
-- (nullable/unconstrained for every other link_type, so this never
-- restricts program_element/bill/outcome_event/finding/meeting/mail_thread/
-- outreach relationship_type values).
ALTER TABLE client_advocacy_matter_link DROP CONSTRAINT IF EXISTS client_advocacy_matter_link_strategy_relationship_check;
ALTER TABLE client_advocacy_matter_link ADD CONSTRAINT client_advocacy_matter_link_strategy_relationship_check CHECK (
  link_type <> 'strategy' OR relationship_type IN ('planned_action', 'completed_action')
);
