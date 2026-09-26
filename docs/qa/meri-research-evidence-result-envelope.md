# Meri research evidence result-envelope adapter

Base: `5dc2c98d40ef204c63abf449b01166787aa4b9e7`.

This opt-in observer adapts successful `get_research_evidence` legacy payloads into `MeriResultEnvelope` while returning the same payload object. It does not change tool registration, dispatch, or live response shape.

The adapter only derives session and requested attachment selection, explicit status and coverage bits, pagination cursor, attachment record IDs and content hashes, and the immutable snapshot `capturedAt`. It reports snapshot capture time as the observation time and does not substitute the current read time. Empty results count as `not_found_within_scope` only when the tool identity, session ID, complete pagination/content bits, counters, and empty record list agree. Cursor pages remain partial because the legacy total is the whole selected snapshot while returned is only the current page; a terminal cursor response alone cannot prove whole-snapshot completeness. Missing or contradictory evidence stays partial or unknown.

The legacy reader intentionally throws the same `NotFoundException` for missing, wrong-owner, client-mismatched, revoked, and stale evidence. The observer serializes no thrown error details and rethrows the original thrown value by reference, preserving that non-disclosure behavior.

Focused validation: `apps/api/src/meri/meri-research-evidence-envelope.spec.ts` — 8 tests. Full API typecheck and Program Element safety verification are recorded with the implementation commit.
