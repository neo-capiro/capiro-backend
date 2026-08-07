-- Funding Opportunities P30 — tier-aware extracted-text ingestion.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- One table: `opportunity_document_text`. The text of an archived attachment,
-- kept SEPARATE from the attachment's metadata row for one reason that matters
-- more than storage layout: the text has its own availability story.
--
-- An attachment can be archived and its text unavailable, and the WHY has four
-- distinct answers, none of which is "the document has no requirements":
--
--   `available`      text is held, bound to a specific attachment version.
--   `not_entitled`   the account's plan does not include extracted text. A
--                    BILLING fact, not a fact about the document.
--   `not_provided`   the provider has no text for this document — a scanned
--                    fax, an image-only PDF. A fact about the DOCUMENT.
--   `pending`        not attempted yet.
--   `failed`         attempted and did not complete.
--
-- Blank must never read as "no requirements". Storing the reason as a column
-- rather than inferring it from an empty string is what makes that impossible.
--
-- THE BINDING THAT MAKES A CITATION SAFE
-- -------------------------------------------------------------------
-- `attachment_content_sha256` is NOT NULL and is the hash of the exact bytes
-- the text came from. P31 will cite this text as evidence for a requirement;
-- if the agency reposts the document, the attachment archives under a NEW hash
-- (P29's key IS the hash), this row no longer matches, and the citation
-- correctly reads as stale rather than silently pointing at text that does not
-- contain the quoted claim.
--
-- PROVIDER AND LOCAL TEXT ARE NEVER MIXED
-- -------------------------------------------------------------------
-- `extraction_method` is part of the uniqueness key, so a document can hold a
-- provider extraction AND a local-parser one as separate, separately labelled
-- rows. What it can never hold is one row whose text came from both — the plan
-- is explicit that a local fallback is a separately recorded method, not a
-- silent substitute.
--
-- WHY GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- The text of a public federal solicitation is public federal data, same
-- category as the attachment it came from.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "opportunity_document_text" (
    "id"                          UUID NOT NULL DEFAULT uuid_generate_v4(),

    -- `opportunity_attachment.id`. Soft pointer, no FK — same reasoning as
    -- every other cross-table reference in this program.
    "attachment_id"               UUID NOT NULL,
    -- The hash of the exact bytes this text came from. NOT NULL: text with no
    -- binding is text nothing may cite.
    "attachment_content_sha256"   TEXT NOT NULL,

    "status"                      TEXT NOT NULL,
    -- 'provider' | 'local_parser'. Never mixed within a row.
    "extraction_method"           TEXT,
    -- The provider plan the extraction was made under, when known. Recorded so
    -- a later downgrade explains why previously-held text stopped refreshing.
    "provider_tier"               TEXT,

    -- UNTRUSTED SOURCE CONTENT. Never interpreted as an instruction anywhere.
    "text"                        TEXT,
    "char_count"                  INTEGER,
    -- True when the provider returned a bounded excerpt rather than the whole
    -- document. A truncated body that claimed to be complete would let P31
    -- conclude a requirement is absent from a document it only half read.
    "truncated"                   BOOLEAN NOT NULL DEFAULT false,

    "failure_reason"              TEXT,
    "fetched_at"                  TIMESTAMPTZ(6),
    "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "opportunity_document_text_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_document_text_status_chk') THEN
        ALTER TABLE "opportunity_document_text"
            ADD CONSTRAINT "opportunity_document_text_status_chk"
            CHECK ("status" IN ('available', 'not_entitled', 'not_provided', 'pending', 'failed'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_document_text_method_chk') THEN
        ALTER TABLE "opportunity_document_text"
            ADD CONSTRAINT "opportunity_document_text_method_chk"
            CHECK ("extraction_method" IS NULL OR "extraction_method" IN ('provider', 'local_parser'));
    END IF;
END $$;

-- `available` REQUIRES text, a method and a count. Anything else must hold NO
-- text at all — so a `not_entitled` row cannot carry a leftover body from a
-- period when the account was entitled, and blank can never be mistaken for
-- "this document has no requirements".
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_document_text_available_chk') THEN
        ALTER TABLE "opportunity_document_text"
            ADD CONSTRAINT "opportunity_document_text_available_chk"
            CHECK (
                ("status" = 'available'
                  AND "text" IS NOT NULL
                  AND "extraction_method" IS NOT NULL
                  AND "char_count" IS NOT NULL
                  AND "fetched_at" IS NOT NULL)
                OR ("status" <> 'available' AND "text" IS NULL AND "char_count" IS NULL)
            );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_document_text_failure_chk') THEN
        ALTER TABLE "opportunity_document_text"
            ADD CONSTRAINT "opportunity_document_text_failure_chk"
            CHECK (
                ("status" = 'failed' AND "failure_reason" IS NOT NULL)
                OR ("status" <> 'failed' AND "failure_reason" IS NULL)
            );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_document_text_hash_chk') THEN
        ALTER TABLE "opportunity_document_text"
            ADD CONSTRAINT "opportunity_document_text_hash_chk"
            CHECK ("attachment_content_sha256" ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

-- One row per (attachment, method). A provider extraction and a local-parser
-- one coexist as separate, separately labelled rows; neither overwrites the
-- other, and no row is ever a blend of the two.
CREATE UNIQUE INDEX IF NOT EXISTS "opportunity_document_text_attachment_method_uniq"
    ON "opportunity_document_text" ("attachment_id", COALESCE("extraction_method", ''));

-- "Is the text I hold still the text for the bytes I archived?" — the staleness
-- check P31 runs before citing anything.
CREATE INDEX IF NOT EXISTS "opportunity_document_text_binding_idx"
    ON "opportunity_document_text" ("attachment_content_sha256");

CREATE INDEX IF NOT EXISTS "opportunity_document_text_status_idx"
    ON "opportunity_document_text" ("status", "created_at");
