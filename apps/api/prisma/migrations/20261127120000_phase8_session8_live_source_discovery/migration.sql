-- Phase 8 Session 8 — Live official-source discovery provenance.
--
-- Session 7's discovery port was manifest-driven: a governed file said which
-- documents existed, so there was nothing to record about how they were found.
-- A live crawler is different. It examines far more than it emits — the real
-- GovInfo `BILLS_2023` sitemap holds 13,354 packages for the handful that
-- resolve to a defence expected source — and it is regularly refused outright:
-- `comptroller.defense.gov`, `asafm.army.mil` and `www.defense.gov` answer a
-- plain client with an Akamai 403, and `saffm.hq.af.mil` does not connect.
--
-- Without a record of that, "discovery found nothing" and "discovery was turned
-- away" and "discovery discarded everything" are indistinguishable. These tables
-- exist so the crawl itself is auditable:
--
--   * every request issued, with its real HTTP status and the SHA-256 of the
--     listing bytes that produced the decisions;
--   * every candidate examined, with the resolution outcome and the reason,
--     whether or not it was emitted.
--
-- Like the Session 7 control plane, this is provenance and contains NO monetary
-- column of any kind. Discovery may state that an official document exists and
-- which expected source it could satisfy; dollars come only through the governed
-- Session 6 evidence-bound ingestion path. The rehearsal asserts the absence of
-- monetary columns against `information_schema` rather than trusting this note.
--
-- Immutable source identity remains `source_document`. Nothing here competes with
-- it: a discovery candidate is a statement about a URL we looked at, not about
-- bytes we have accepted.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. One row per request issued to a publisher.
--
-- Append-only. A refusal is a first-class, recorded outcome — `status` cannot be
-- 'succeeded' without a 2xx, so a blocked crawl can never be written as a
-- successful one.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_discovery_crawl" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "adapter_id" TEXT NOT NULL,
  "run_key" TEXT NOT NULL,
  "request_url" TEXT NOT NULL,
  "resource_kind" TEXT NOT NULL,
  "status_code" INTEGER,
  "status" TEXT NOT NULL,
  "content_sha256" CHAR(64),
  "byte_size" INTEGER,
  "items_seen" INTEGER NOT NULL DEFAULT 0,
  "robots_unavailable" BOOLEAN NOT NULL DEFAULT FALSE,
  "effective_interval_ms" INTEGER NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "finished_at" TIMESTAMPTZ(6) NOT NULL,
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dbdc_resource_kind_chk" CHECK (
    "resource_kind" IN ('robots', 'sitemap_index', 'sitemap', 'listing', 'feed', 'metadata')
  ),
  CONSTRAINT "dbdc_status_chk" CHECK (
    "status" IN (
      'succeeded',
      'blocked_by_publisher',
      'blocked_by_robots',
      'unreachable',
      'budget_exhausted'
    )
  ),
  -- A success must carry a 2xx. This is what stops a 403 from being recorded as
  -- a successful crawl that simply found nothing.
  CONSTRAINT "dbdc_success_requires_2xx_chk" CHECK (
    "status" <> 'succeeded'
    OR ("status_code" IS NOT NULL AND "status_code" BETWEEN 200 AND 299)
  ),
  -- Conversely, a publisher block must carry the real status it was blocked with.
  CONSTRAINT "dbdc_blocked_requires_status_chk" CHECK (
    "status" <> 'blocked_by_publisher' OR "status_code" IS NOT NULL
  ),
  -- An unreachable host produced no HTTP response at all, so it cannot have one.
  CONSTRAINT "dbdc_unreachable_has_no_status_chk" CHECK (
    "status" <> 'unreachable' OR "status_code" IS NULL
  ),
  -- Anything that failed has to say why.
  CONSTRAINT "dbdc_failure_reason_chk" CHECK (
    "status" = 'succeeded' OR "failure_reason" IS NOT NULL
  ),
  CONSTRAINT "dbdc_https_only_chk" CHECK ("request_url" LIKE 'https://%'),
  CONSTRAINT "dbdc_interval_chk" CHECK ("effective_interval_ms" >= 0),
  CONSTRAINT "dbdc_items_chk" CHECK ("items_seen" >= 0),
  CONSTRAINT "dbdc_window_chk" CHECK ("finished_at" >= "started_at")
);

CREATE INDEX "dbdc_adapter_started_idx"
  ON "defense_budget_discovery_crawl" ("adapter_id", "started_at" DESC);
CREATE INDEX "dbdc_run_key_idx" ON "defense_budget_discovery_crawl" ("run_key");
CREATE INDEX "dbdc_status_idx" ON "defense_budget_discovery_crawl" ("status");

-- ───────────────────────────────────────────────────────────────────────────
-- 2. One row per candidate examined.
--
-- The central structural guarantee of this session: a resolved candidate MUST
-- carry an expected-source dedup key, and an unresolved one MUST NOT. That makes
-- "the crawler invented an identity for a document it did not understand"
-- unrepresentable rather than merely discouraged.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_discovery_candidate" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "crawl_id" UUID NOT NULL
    REFERENCES "defense_budget_discovery_crawl" ("id") ON DELETE RESTRICT,
  "adapter_id" TEXT NOT NULL,
  "run_key" TEXT NOT NULL,
  "candidate_url" TEXT NOT NULL,
  "package_id" TEXT,
  "title" TEXT,
  "resolution" TEXT NOT NULL,
  "expected_source_dedup_key" CHAR(64),
  "classified_fiscal_year" INTEGER,
  "reason" TEXT NOT NULL,
  "emitted" BOOLEAN NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dbdcand_resolution_chk" CHECK (
    "resolution" IN (
      'resolved',
      'unresolved_unparseable_package',
      'unresolved_not_defense_subject',
      'unresolved_fiscal_year_unknown',
      'unresolved_fiscal_year_out_of_horizon',
      'unresolved_stage_not_expected',
      'unresolved_no_registered_expected_source'
    )
  ),
  -- Resolved <=> carries a dedup key. Both directions, so neither a fabricated
  -- key nor a silently keyless "resolution" can be stored.
  CONSTRAINT "dbdcand_resolved_has_key_chk" CHECK (
    ("resolution" = 'resolved') = ("expected_source_dedup_key" IS NOT NULL)
  ),
  -- Only a resolved candidate may be emitted to the control loop.
  CONSTRAINT "dbdcand_emitted_requires_resolved_chk" CHECK (
    "emitted" = FALSE OR "resolution" = 'resolved'
  ),
  CONSTRAINT "dbdcand_https_only_chk" CHECK ("candidate_url" LIKE 'https://%'),
  CONSTRAINT "dbdcand_reason_chk" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "dbdcand_fy_chk" CHECK (
    "classified_fiscal_year" IS NULL
    OR "classified_fiscal_year" BETWEEN 1900 AND 2200
  )
);

-- A retried run must not duplicate the audit trail.
CREATE UNIQUE INDEX "dbdcand_run_url_uidx"
  ON "defense_budget_discovery_candidate" ("adapter_id", "run_key", "candidate_url");
CREATE INDEX "dbdcand_crawl_idx" ON "defense_budget_discovery_candidate" ("crawl_id");
CREATE INDEX "dbdcand_resolution_idx" ON "defense_budget_discovery_candidate" ("resolution");
CREATE INDEX "dbdcand_dedup_key_idx"
  ON "defense_budget_discovery_candidate" ("expected_source_dedup_key")
  WHERE "expected_source_dedup_key" IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Per-HOST request pacing.
--
-- Keyed by host, not by adapter, because adapters share hosts: `dod-comptroller`
-- and `dod-comptroller-reprogramming` both publish on comptroller.defense.gov,
-- and all three GovInfo adapters publish on www.govinfo.gov. Per-adapter pacing
-- would let concurrent runs multiply the real request rate at one publisher.
--
-- The reservation is a single atomic UPDATE (see the store), so two workers on
-- two adapters that share a host cannot both conclude they may request now.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "defense_budget_discovery_host_budget" (
  "host" TEXT PRIMARY KEY,
  "next_request_allowed_at" TIMESTAMPTZ(6) NOT NULL,
  "last_reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reservation_count" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dbdhb_host_chk" CHECK (length(btrim("host")) > 0),
  CONSTRAINT "dbdhb_count_chk" CHECK ("reservation_count" >= 0)
);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Least-privilege grants.
--
-- Identical posture to Session 7: serve reads, job reads and writes, neither
-- deletes. An append-only crawl history is the point — a superseded decision, a
-- refusal and a failed run all stay auditable.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE "defense_budget_discovery_crawl" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_discovery_candidate" FROM PUBLIC;
REVOKE ALL ON TABLE "defense_budget_discovery_host_budget" FROM PUBLIC;

GRANT SELECT ON TABLE "defense_budget_discovery_crawl" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_discovery_candidate" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "defense_budget_discovery_host_budget" TO "capiro_defense_serve";

GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_discovery_crawl" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_discovery_candidate" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_discovery_host_budget" TO "capiro_defense_job";
