-- Committee news uses the existing global update feed. Expand only its type
-- constraint; keep every existing type and all table ownership/grants/RLS.
-- One ALTER statement makes constraint replacement atomic under Prisma's
-- normal PostgreSQL migrate-deploy runner (no interval without validation).
ALTER TABLE "committee_site_update"
  DROP CONSTRAINT "committee_site_update_update_type_chk",
  ADD CONSTRAINT "committee_site_update_update_type_chk" CHECK ("update_type" IN (
    'hearing_announced', 'date_changed', 'time_changed', 'room_changed', 'postponed', 'canceled',
    'witness_added', 'witness_removed', 'witness_testimony_published', 'committee_memo_published',
    'bill_added', 'amendment_added', 'livestream_posted', 'livestream_changed', 'archive_posted',
    'official_transcript_posted', 'committee_news_published'
  ));
