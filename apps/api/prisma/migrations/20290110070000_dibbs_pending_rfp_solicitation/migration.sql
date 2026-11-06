-- Keep the existing nonblank check on assigned numbers and the unique provider ID.
ALTER TABLE "tango_dibbs_solicitation"
  ALTER COLUMN "solicitation" DROP NOT NULL,
  ADD CONSTRAINT "tango_dibbs_solicitation_pending_rfp_chk"
    CHECK (
      "solicitation" IS NOT NULL OR (
        "document_type" = 'rfp' AND
        "tango_dibbs_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    );
