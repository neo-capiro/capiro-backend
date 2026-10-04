# Independent final source review

Verdict: PASS — reviewed source correction; this is not acceptance or replay of the retained capture.

P1: Closed. `memory-canonical-activation.helpers.ts` defines the DB `source_content_hash` as SHA-256(`key + NUL + value`), so comparing it with SHA-256(text) was the wrong contract. The API read version is separately SHA-256(`text + NUL + sourceVersion`) in `meri-memory-content.helpers.ts`. The retained Case 14 readback reports DB provenance hash `e398859f…938af8cc` and API current version `content:663dadd3…fd8ca50b`; the corrected join independently recomputes the latter from the full returned text and source version, then joins DB hash to the authoritative owner fixture and readback provenance. It also binds approved full text, complete/unpaged read, physical source, candidate ID, candidate sourceVersion, receipt currentVersion and citation version/text. The regression changes all three currentVersion copies together while preserving text; the recomputation still rejects it.

P2: Closed. Citation suffix handling uses the actual Unicode ellipsis (`…`); a Case 01 partial-citation regression is present. Case 01's byte-to-owner-hash comparison remains intact; its authority fixture test source is unchanged.

Evidence boundary: The retained run remains failed/unaccepted: `observed-summary.json` says `NOT_RUN` and retains semantic-clock and `source_tenant_authority_unproved` blockers; `observed-source.json` still has no API release SHA. The join code permits explicitly UNKNOWN tenant/client observations only as unresolved blockers and returns joins-only validation, not capture acceptance. These source changes do not erase tenant uncertainty, context incompleteness, or the old run's failure.

Source/evidence review only. No edits beyond this review, tests, network, or cloud actions were performed.