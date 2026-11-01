# Exact federal draft source

`read_federal_draft_source` is an authenticated native read over the existing global federal evidence owner. Select the exact `billId`, `versionCode`, `revisionId`, `versionHash` and `textHash` returned by `read_bill_text`. No designation, default version, URL fetch, new source store or migration is introduced.

The query uses the actual `federal_evidence_current` view and immutable revision table. A removed, partial or mismatched revision is unavailable. PostgreSQL bounds retained content at 1 MiB and extracted text at 128 KiB of UTF-8 before returning either. Core checks both hashes and returns only extracted text. Unsupported publisher locators and failed integrity remain unavailable; no truncated draft source is returned.

Publication, modification and fetch dates remain separate and nullable where the owner permits. `evidenceParserVersion` is the existing evidence extraction version; it does not establish text normalization. Original HTTP bytes, legal structure, enactment and legal currency are explicitly unreported or unresolved. Enrolled text is not declared enacted law.

The PostgreSQL test installs the two source tables and current view from the existing migration in an isolated synthetic database, reads as its ordinary role, and exercises actual MeriTools dispatch. The saved wire vector is synthetic. It tests removal, exact selection, partial extraction, corruption, UTF-8 byte limits and publisher mismatch. This adds no authentication or tenant-policy owner; the native route retains its existing authentication.

This is source preparation. It does not approve or publish a draft, activate a feature, or qualify a deployed workflow. The delegated saved-job allowlist has not been extended.
