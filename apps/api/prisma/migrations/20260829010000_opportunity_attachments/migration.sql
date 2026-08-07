-- Funding Opportunities P29 — attachment metadata and secure archive.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- One table: `opportunity_attachment`. Metadata for every attachment Capiro
-- knows about on a solicitation, plus — when it has been fetched — where the
-- archived copy lives and what its bytes hash to.
--
-- WHY METADATA AND ARCHIVE ARE ONE TABLE, WITH A STATUS
-- -------------------------------------------------------------------
-- Knowing an attachment EXISTS and holding a copy of it are different facts,
-- and the difference matters to every downstream reader: P30's text ingestion
-- and P31's requirement extraction may only ever bind a claim to an ARCHIVED
-- document. Two tables would let a metadata row and an archive row disagree
-- about the same file. One row with an explicit `status` cannot.
--
--   `metadata_only`  we know the URL. Nothing has been fetched.
--   `archived`       fetched, checksummed and stored. The only status a
--                    downstream claim may cite.
--   `refused`        the fetch was REFUSED before any byte was read — a
--                    non-HTTPS URL, a private-network host, a disallowed MIME
--                    type, an oversized declared length. A safety decision.
--   `failed`         the fetch was attempted and did not complete — a timeout,
--                    a truncated body, a checksum mismatch, a decompression
--                    ratio over the ceiling. An operational outcome.
--
-- `refused` and `failed` are SEPARATE on purpose. One is Capiro declining to
-- go somewhere and needs no retry; the other is a transient condition that a
-- later run should try again. Collapsing them would either retry an SSRF
-- attempt forever or give up on a flaky download.
--
-- THE CHECK THAT MATTERS MOST
-- -------------------------------------------------------------------
-- `status = 'archived'` REQUIRES the bucket, the key, the byte count and the
-- SHA-256. A failed fetch cannot mark metadata complete — that is this phase's
-- own acceptance line, and it is enforced by the database rather than by the
-- service that writes it.
--
-- WHY GLOBAL, WITH NO tenant_id AND NO RLS
-- -------------------------------------------------------------------
-- Same reasoning as `sam_opportunity` and every `tango_*` table: an attachment
-- on a federal solicitation is a fact about the federal marketplace. The
-- ARCHIVE bucket is private and its objects are reached only through a
-- server-side, audited path; the metadata row itself carries nothing tenant-
-- specific.
--
-- WHY THE ARCHIVE KEY IS IMMUTABLE
-- -------------------------------------------------------------------
-- `archive_key` embeds the content hash, so re-archiving identical bytes
-- produces the identical key (a free no-op) and CHANGED bytes produce a
-- DIFFERENT key rather than overwriting the old object. A requirement
-- extracted from version A must still resolve to version A's bytes after the
-- agency posts version B — otherwise a citation silently starts pointing at
-- text that does not contain the quoted claim.
--
-- RETRY-SAFE. Every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "opportunity_attachment" (
    "id"                  UUID NOT NULL DEFAULT uuid_generate_v4(),

    -- Where this attachment hangs. At least one must be present; the CHECK
    -- below enforces it. `sam_opportunity_id` is a SOFT pointer with no FK,
    -- matching every other cross-catalog reference in this program.
    "sam_opportunity_id"  UUID,
    "tango_notice_id"     TEXT,

    -- The provider/source URL, verbatim. THE natural key together with its
    -- parent: an agency reposting the same document at the same URL is the
    -- same attachment, and a second row for it would double-count.
    "source_url"          TEXT NOT NULL,

    -- Source-stated metadata. All nullable: SAM.gov's own resource links carry
    -- a URL and often nothing else, and inventing a filename from the URL's
    -- last path segment is a guess that reads like a fact.
    "file_name"           TEXT,
    "declared_mime_type"  TEXT,
    "declared_size_bytes" BIGINT,
    "posted_date"         TIMESTAMPTZ(6),

    -- Observed on fetch. Null until then.
    "observed_mime_type"  TEXT,
    "observed_size_bytes" BIGINT,
    "content_sha256"      TEXT,

    -- Where the archived copy lives. Null until archived.
    "archive_bucket"      TEXT,
    "archive_key"         TEXT,
    "archive_version_id"  TEXT,

    "status"              TEXT NOT NULL DEFAULT 'metadata_only',
    -- A bounded machine reason, plus a sanitized human detail. The detail
    -- NEVER contains any part of the file body.
    "failure_reason"      TEXT,
    "failure_detail"      TEXT,

    "first_seen_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_attempt_at"     TIMESTAMPTZ(6),
    "archived_at"         TIMESTAMPTZ(6),
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "opportunity_attachment_pkey" PRIMARY KEY ("id")
);

-- An attachment with no parent is unreachable and uncitable.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_attachment_parent_chk') THEN
        ALTER TABLE "opportunity_attachment"
            ADD CONSTRAINT "opportunity_attachment_parent_chk"
            CHECK ("sam_opportunity_id" IS NOT NULL OR "tango_notice_id" IS NOT NULL);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_attachment_status_chk') THEN
        ALTER TABLE "opportunity_attachment"
            ADD CONSTRAINT "opportunity_attachment_status_chk"
            CHECK ("status" IN ('metadata_only', 'archived', 'refused', 'failed'));
    END IF;
END $$;

-- THE acceptance line, as a constraint: a failed fetch cannot mark metadata
-- complete. `archived` requires every one of the four archive facts.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_attachment_archived_chk') THEN
        ALTER TABLE "opportunity_attachment"
            ADD CONSTRAINT "opportunity_attachment_archived_chk"
            CHECK (
                "status" <> 'archived'
                OR (
                    "archive_bucket" IS NOT NULL
                    AND "archive_key" IS NOT NULL
                    AND "content_sha256" IS NOT NULL
                    AND "observed_size_bytes" IS NOT NULL
                    AND "archived_at" IS NOT NULL
                )
            );
    END IF;
END $$;

-- And the converse: a row that is NOT archived must carry no archive location,
-- so a stale bucket/key left over from an earlier success cannot make a failed
-- row look citable.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_attachment_unarchived_chk') THEN
        ALTER TABLE "opportunity_attachment"
            ADD CONSTRAINT "opportunity_attachment_unarchived_chk"
            CHECK (
                "status" = 'archived'
                OR ("archive_bucket" IS NULL AND "archive_key" IS NULL AND "archive_version_id" IS NULL)
            );
    END IF;
END $$;

-- A refusal or a failure must say why. An unexplained one is unactionable.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_attachment_failure_chk') THEN
        ALTER TABLE "opportunity_attachment"
            ADD CONSTRAINT "opportunity_attachment_failure_chk"
            CHECK (
                ("status" IN ('refused', 'failed') AND "failure_reason" IS NOT NULL)
                OR ("status" NOT IN ('refused', 'failed') AND "failure_reason" IS NULL)
            );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_attachment_hash_chk') THEN
        ALTER TABLE "opportunity_attachment"
            ADD CONSTRAINT "opportunity_attachment_hash_chk"
            CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$');
    END IF;
END $$;

-- Sizes are byte counts. A negative one is a mapping bug.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opportunity_attachment_size_chk') THEN
        ALTER TABLE "opportunity_attachment"
            ADD CONSTRAINT "opportunity_attachment_size_chk"
            CHECK (
                ("declared_size_bytes" IS NULL OR "declared_size_bytes" >= 0)
                AND ("observed_size_bytes" IS NULL OR "observed_size_bytes" >= 0)
            );
    END IF;
END $$;

-- One row per (parent, url). An agency reposting the same document at the same
-- URL is the same attachment; a second row would double-count it. COALESCE
-- rather than a plain composite, because Postgres treats NULLs as distinct and
-- a notice-parented row would otherwise admit unlimited duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "opportunity_attachment_parent_url_uniq"
    ON "opportunity_attachment" (
        COALESCE("sam_opportunity_id"::text, ''),
        COALESCE("tango_notice_id", ''),
        "source_url"
    );

-- "Everything on this solicitation", which is how the detail surface reads it.
CREATE INDEX IF NOT EXISTS "opportunity_attachment_sam_idx"
    ON "opportunity_attachment" ("sam_opportunity_id", "status");

-- The archive worker's own queue: what is still unfetched, oldest first.
CREATE INDEX IF NOT EXISTS "opportunity_attachment_status_idx"
    ON "opportunity_attachment" ("status", "first_seen_at");

-- Deduplication across solicitations. The same Q&A document is routinely
-- attached to several notices; identical bytes archive to the identical key,
-- and this is how a second parent finds the existing object.
CREATE INDEX IF NOT EXISTS "opportunity_attachment_hash_idx"
    ON "opportunity_attachment" ("content_sha256");
