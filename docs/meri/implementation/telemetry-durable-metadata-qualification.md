# Durable telemetry metadata projection

Qualified core-only follow-on to ceabc8062efc4dd1aea5dc6ac4825e38e5aca8f3. Adds five explicit research span boundaries and optional owner metadata: durable run/session/authorized conversation identifiers; lease/checkpoint counters; finite cancellation, terminal, verification, source-coverage and effort enums; prompt/tool/skill/artifact version identifiers; remaining attempts/tokens/costMicros/timeMs.

Only nonnegative safe integers export for budget and counters. Reported zero stays zero; absent, null, invalid or unknown quantities stay absent. Identifiers use the existing canonical-ID-or-SHA256 sanitizer; this is hashing, not encryption or HMAC. Metadata does not replace authenticated tenant/actor or runtime trace/run context. No arbitrary payload fields pass through. Owner callsites must supply these values only after their existing authorization/receipt/CAS checks; this projection itself grants no authority.

Validation: core build, formatting and diff checks exit 0. Forty tests across two suites exit 0, including actual SDK spans/events/parentage for all five boundaries, budget absence/zero behavior, malformed inputs, spoofed context fields and privacy; prior real loopback OTLP test remains passing. The initial five new tests incorrectly selected spans by event name; they were corrected to the existing fixed boundary span names. That failing output is preserved.

Independent Bedrock Hermes/Kimi static review PASS, actual exit 0, 19.2 seconds, session 20260929_024034_a5aa26. Reviewer did not execute tests. Its commentary incorrectly calls the existing SHA256 sanitizer HMAC and loosely describes projection order; source inspection confirms the actual contract above: explicit projection never includes tenantId/runId input fields. Neither remark changes the reviewed patch or verdict.

This increment qualifies the projection/export seam only. Durable run/child/budget/source owner execution is a separate in-progress increment; live collector configuration, release and end-to-end live joins remain NOT RUN.

Evidence: C:/dev/cap-meri-foundation-evidence/telemetry-export-plan/durable-metadata-tests-final.log and telemetry-durable-metadata-review receipts in its parent.
