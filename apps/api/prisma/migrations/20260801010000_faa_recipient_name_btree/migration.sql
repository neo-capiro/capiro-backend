-- District Nexus: make the assistance recipient-name join index-driven.
--
-- `aggregateAssistance` filters `recipient_name = ANY($1)`. The only index on
-- that column is `faa_recipient_name_trgm_idx`, a GIN trigram on
-- lower(recipient_name) built for the similarity search in the mapping picker.
-- An equality predicate cannot use a trigram GIN, so the client rail
-- sequentially scans the largest new table -- and the firm-wide map aggregate
-- (WS-E1) would do it once per request across every mapped client.
--
-- Indexed on lower(...) rather than the bare column, and the query lowercases
-- its inputs to match. Recipient names arrive from two different worlds:
-- USAspending returns them uppercase, while ClientIntelMapping.externalName is
-- operator-entered. A case-sensitive equality join silently dropped every
-- award whose casing differed, which reads as "this client has no assistance
-- awards" rather than as a missed match. This is the same lower() convention
-- the trigram index and searchAssistanceRecipients already use.
--
-- Plain CREATE INDEX, deliberately not CONCURRENTLY: Prisma wraps each
-- migration in a transaction and CONCURRENTLY cannot run inside one. That is
-- safe here because federal_assistance_award is empty -- the
-- sync-federal-assistance-awards job has never run in any environment -- so the
-- build is instant and takes no meaningful lock. If this table has been
-- populated before you apply this, build the index by hand with CONCURRENTLY
-- first and let this statement no-op via IF NOT EXISTS.
--
-- Rollback: DROP INDEX "faa_recipient_name_lower_idx";

CREATE INDEX IF NOT EXISTS "faa_recipient_name_lower_idx"
  ON "federal_assistance_award" (lower("recipient_name"));
