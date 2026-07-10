-- Phase 1 M3.1 — state agency rulemaking, mirrors federal_register_document.
CREATE TABLE "state_rule" (
  "id"                  TEXT NOT NULL,
  "state"               TEXT NOT NULL,
  "agency"              TEXT NOT NULL,
  "title"               TEXT NOT NULL,
  "abstract"            TEXT,
  "rule_type"           TEXT NOT NULL,
  "docket_id"           TEXT,
  "register_citation"   TEXT,
  "publication_date"    DATE NOT NULL,
  "comment_start_date"  DATE,
  "comment_end_date"    DATE,
  "effective_date"      DATE,
  "source_url"          TEXT NOT NULL,
  "linked_bill_keys"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "synced_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "state_rule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "state_rule_state_publication_date_idx" ON "state_rule" ("state", "publication_date");
CREATE INDEX "state_rule_comment_end_date_idx" ON "state_rule" ("comment_end_date");
