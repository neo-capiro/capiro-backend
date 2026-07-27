-- Engagement Phase 1 — governed Generation Gateway + Evidence Packets.
--
-- Purely ADDITIVE columns on two existing tables. No table is created, nothing
-- is dropped, no RLS policy or index is replaced, and every column has a safe
-- default so historical rows keep working without a backfill.
--
--   context_packet          upgraded from a steering-memory-only trace into a
--                           complete Evidence Packet (directives, evidence,
--                           source failures, policy, model policy, hash,
--                           freshness window).
--   engagement_attachments  gains an upload lifecycle: quarantine → scan →
--                           ready, verified content type, calculated digest,
--                           and extraction bookkeeping.
--
-- NOTE ON TABLE NAME: the Phase 1 plan calls this table `context_packets`; the
-- actual table created by 20260703010000_meri_context_packet is SINGULAR
-- (`context_packet`, Prisma model ContextPacket @@map("context_packet")). The
-- singular name is authoritative here.
--
-- RLS: context_packet and engagement_attachments already have tenant-isolation
-- policies (per-command / FORCEd). ALTER TABLE ... ADD COLUMN does not disturb
-- them, and capiro_app already holds table-level DML grants, so no GRANT is
-- re-issued (column privileges are inherited from the table grant).

-- ---------------------------------------------------------------------------
-- 1. context_packet — Evidence Packet v2 fields
-- ---------------------------------------------------------------------------
-- packet_version: 1 = the legacy steering-only trace (every historical row).
-- 2 = a full Evidence Packet written by EvidencePacketService. The DEFAULT is
-- deliberately 2 (new writes are v2), and existing rows are explicitly pinned
-- to 1 below so a v1 trace can never be mistaken for a complete packet.
ALTER TABLE "context_packet"
  ADD COLUMN IF NOT EXISTS "packet_version" INTEGER NOT NULL DEFAULT 2,
  -- AuthenticatedDirective[]: objective/template/tone/length/item_instruction/
  -- custom_note, each stamped with the authenticated user id.
  ADD COLUMN IF NOT EXISTS "directives_jsonb" JSONB NOT NULL DEFAULT '[]',
  -- EvidenceItem[]: ref (source type/id/trust/as-of) + bounded excerpt +
  -- optional structured truth. References and EXCERPTS only — never a whole
  -- mailbox thread or an unbounded document.
  ADD COLUMN IF NOT EXISTS "evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
  -- SourceFailure[]: every source that could not be loaded, with severity.
  -- A failure is NEVER silently converted into empty context.
  ADD COLUMN IF NOT EXISTS "source_failures_jsonb" JSONB NOT NULL DEFAULT '[]',
  -- The resolved government-affairs policy (jurisdiction, audience, version).
  ADD COLUMN IF NOT EXISTS "policy_jsonb" JSONB NOT NULL DEFAULT '{}',
  -- Pinned provider/model/prompt-spec identity for the whole operation.
  ADD COLUMN IF NOT EXISTS "model_policy_jsonb" JSONB NOT NULL DEFAULT '{}',
  -- sha256 over the canonical (stable-key-ordered) packet JSON.
  ADD COLUMN IF NOT EXISTS "packet_hash" VARCHAR(80),
  -- Denormalized count of severity='critical' failures so a gate can be a
  -- cheap indexed read instead of a JSONB scan.
  ADD COLUMN IF NOT EXISTS "critical_failure_count" INTEGER NOT NULL DEFAULT 0,
  -- Freshness window across every included evidence source's as-of date.
  ADD COLUMN IF NOT EXISTS "freshest_source_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "stalest_source_at" TIMESTAMPTZ(6);

-- Historical rows are v1 steering-only traces. Pin them explicitly: the column
-- default (2) applies to new INSERTs, but a pre-existing row backfilled with
-- the default would otherwise claim to be a complete Evidence Packet.
UPDATE "context_packet" SET "packet_version" = 1 WHERE "packet_version" = 2 AND "packet_hash" IS NULL;

-- Gateway lookups: "the packets for this tenant/surface that had critical
-- failures", newest first.
CREATE INDEX IF NOT EXISTS "context_packet_tenant_version_created_idx"
  ON "context_packet" ("tenant_id", "packet_version", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- 2. engagement_attachments — quarantine / scan / extraction lifecycle
-- ---------------------------------------------------------------------------
-- lifecycle_status defaults to 'legacy_ready' so EXISTING attachments keep
-- downloading and extracting exactly as before. New uploads are written as
-- 'quarantined' by confirmAttachment() — that is a service-layer decision, NOT
-- a column default, precisely so this migration cannot retroactively quarantine
-- (i.e. break) historical documents.
--
-- Historical rows are deliberately left scan_status = NULL. NULL means "never
-- scanned", which is honest; marking them 'clean' would be a fabricated
-- security assertion about bytes no scanner has ever seen.
ALTER TABLE "engagement_attachments"
  -- 'legacy_ready' | 'quarantined' | 'ready' | 'blocked' | 'delete_pending' | 'delete_failed'
  ADD COLUMN IF NOT EXISTS "lifecycle_status" VARCHAR(32) NOT NULL DEFAULT 'legacy_ready',
  -- Content type detected from MAGIC BYTES, not the declared MIME/extension.
  ADD COLUMN IF NOT EXISTS "verified_content_type" VARCHAR(255),
  -- sha256 the server calculated from the stored object (the client-supplied
  -- checksum_sha256 column above is an untrusted claim and stays separate).
  ADD COLUMN IF NOT EXISTS "calculated_sha256" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "scan_provider" VARCHAR(64),
  -- 'pending' | 'clean' | 'threat' | 'unsupported' | 'access_denied' | 'failed'
  -- | 'scanner_not_required'
  ADD COLUMN IF NOT EXISTS "scan_status" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "scan_result_at" TIMESTAMPTZ(6),
  -- 'pending' | 'extracted' | 'truncated' | 'empty' | 'failed' | 'unsupported'
  ADD COLUMN IF NOT EXISTS "extraction_status" VARCHAR(32),
  -- { chars, truncated, pageLimitHit, rowLimitHit, timedOut, extractedAt … }
  ADD COLUMN IF NOT EXISTS "extraction_metadata_jsonb" JSONB NOT NULL DEFAULT '{}';

-- Lifecycle sweeps: pending scans and delete_failed reconciliation, per tenant,
-- oldest-first.
CREATE INDEX IF NOT EXISTS "engagement_attachments_tenant_lifecycle_created_idx"
  ON "engagement_attachments" ("tenant_id", "lifecycle_status", "created_at");
