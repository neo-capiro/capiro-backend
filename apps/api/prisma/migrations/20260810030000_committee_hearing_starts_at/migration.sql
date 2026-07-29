-- committee_hearing.starts_at — the true UTC instant a hearing begins.
--
-- WHY
-- `date` (@db.Date) and `time` (TEXT, "10:00 AM") are DISPLAY fields and cannot
-- answer "is this hearing happening right now": `time` is a formatted local
-- string carrying no zone, and `date` has only day resolution. Anything doing
-- liveness or windowing had to re-parse that string and guess a timezone.
--
-- Both were also being derived from Congress.gov's UTC instant via
-- getUTCHours(), on the documented-but-false premise that Congress.gov encodes
-- Eastern wall-clock in a Z-suffixed field. It does not: 2026-07-29T12:30:00Z is
-- 8:30 AM ET. Every hearing time in the product therefore read 4 hours late (5
-- in winter) — verified 2026-07-29 against senate.gov's own hearings.xml, where
-- all five of that day's hearings were off by exactly +4h. The same instant fed
-- the @db.Date column, so an 8:00 PM ET hearing (00:00Z the NEXT day) was ALSO
-- filed under the wrong calendar day and simultaneously lost its time, because
-- 00:00Z is Congress.gov's "date known, time unknown" sentinel.
--
-- ADDITIVE AND NULLABLE, WITH NO DATA MIGRATION.
-- Existing rows are backfilled by re-running `sync-hearings`, which upserts the
-- whole corpus (~2,640 committee-meeting rows + ~888 transcript rows per pass)
-- through the corrected derivation. Keeping the backfill in the production code
-- path rather than in DDL means this migration cannot partially corrupt
-- anything, it is trivially re-runnable, and any row the sync has not yet
-- re-touched reads NULL — absent rather than wrong.
--
-- NULL is also the permanent, correct value for a genuine date-only record: a
-- hearing announced without a time must not be given a fabricated midnight.
ALTER TABLE "committee_hearing" ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMPTZ(6);

-- Liveness and forward-window reads filter and order on starts_at. Declared as a
-- plain (non-partial) index so it matches the `@@index([startsAt])` in
-- schema.prisma exactly — a partial index is not expressible in the Prisma schema
-- and would read as drift to anyone running `prisma migrate dev`.
CREATE INDEX IF NOT EXISTS "committee_hearing_starts_at_idx"
  ON "committee_hearing" ("starts_at");
