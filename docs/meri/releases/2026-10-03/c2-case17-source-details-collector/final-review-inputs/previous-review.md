# Case17 source-details review

Status: ACTIONABLE DEFECT — not PASS.

## Finding

`Evidence/evals/meri/live-v1/case17-memory-ui.mjs:60-65` maps a fixture record to `personal` only when `record.payload.facts.scope === 'private'`; otherwise it classifies by client presence, falling back to `firm`.

The supplied fixture-owner contract at `Evidence/evals/meri/live-v1/fixture-provisioning/memory-candidate-owner.mjs:40-47` accepts both `'private'` and `'user_private'` as the private/user-private scope. For a selected record using the supported `'user_private'` spelling, the collector expects a firm/client API row while the owner creates/attests it as personal. The join then fails (or asserts the wrong scope), and the visible scope label would not match the intended personal-memory label. Align the collector's scope normalization with the owner contract, or establish and enforce that the six Case17 records use only `'private'`. The supplied evidence does not include the manifest/fact payloads needed to establish which spelling the current six records use, so this is a supported-input inconsistency, not a claim that a live fixture has already failed.

The baseline UI/saved-check tests construct expected scopes using the same `'private'`-only condition (`tests/case17-memory-ui.test.mjs:31-36`, `tests/case17-saved-checks.test.mjs:36-42`), so those fixtures would not exercise the alternate spelling. No test result is inferred here.

## Source-level checks

- The six expected logical records are selected as `MEM-PENDING-17-A` through `-F` by `memory-pending-fixture-plan.mjs:29-43`. Collector joins each selection record to the canonical owner row by logical ID and the API candidate by physical ID; it binds tenant, proposer, payload hash, marker hash, pending state, client/scope, key/value, and null canonical item (`case17-memory-ui.mjs:49-103`). It also requires six distinct owner physical IDs and marker hashes. The synthetic recorded-source pair must be exactly `{sourceType, sourceId}`, and its source ID must equal that record's ownership marker SHA-256.
- Saved evidence independently repeats the owner/API joins in both required rounds (`case17-saved-checks.mjs:26-78`), checks the exact source labels/reference strings and expanded/visible flags, and rejects duplicate screenshot references across rounds (`:79-89`).
- Production UI source has a native `<details><summary>Source details</summary>` control and renders the source type and reference from the optional recorded-source API field (`Evidence/apps/web/src/vnext/meri/MeriMemoryTab.tsx:1034-1043`). Collector correctly locates the native `summary` rather than an ARIA summary role, expands it, checks exact visible text, hashes expanded card text, and captures the card (`case17-memory-ui.mjs:348-390`). Its screenshot helper checks the card's bounds against viewport and clipping/scroll ancestors before capture (`:165-200`). These are source inspections only; screenshot bytes and live rendering have not been observed.
- API `recordedSource` is optional, generated only when the current client-memory wall permits content, and sourced from the stored `sourceType`/`sourceId` fields (`Evidence/apps/api/src/memory/governed-memory-candidate.service.ts:293-319, 518-529`). The added field does not alter list ownership, status, proposal payload, cursor/page bounds, or withdrawal capability in the reviewed source.
- Reviewed collector limits remain bounded (10 API pages, 50 candidates/page, 9 UI load-more actions, 24 collector reads, 120-second collector deadline, 262,144-byte API responses); navigation is restricted to the approved Meri origin and write requests are denied by the guard. Source contains no synthesis/model submission or application mutation path. Existing current actor/tenant and owner readbacks remain checked in the collector.
- Source-details remain a read-only display slice; no original prompt or human acceptance claim is introduced. The grader labels full Case17 acceptance false and requires separate saved visual review (`grade-case17-capture.mjs:40-63`).

## Pending evidence (not run / not observed)

- Candidate baseline and separately prepared tests: NOT RUN by this review lane.
- Native authenticated served capture, including current six fixture marker/physical-row joins and both actual rendered rounds: NOT RUN / NOT OBSERVED.
- Saved screenshot bytes, PNG integrity, natural clipping, and independent saved-check execution: NOT RUN / NOT OBSERVED.
- Human visual review and any Case17/full-file acceptance: NOT RUN; not claimed.

This is a read-only source review. No evidence source files were changed; only this REVIEW.md was written.
