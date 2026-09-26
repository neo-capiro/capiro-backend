# `get_bill_status` result envelope — bounded Phase 2 local contract

Base commit: `d2528bcdf2ee23758eb32839121c9af7dd919d2e` (provisional integration HEAD).
Scope: additive, dormant success observer and result mapper. No dispatch, tool-schema, planner, model-output, database, or source-sync change.

## Handler facts used

`MeriToolsService.getBillStatus` resolves a canonical bill ID before querying. If a designation lacks a Congress or otherwise cannot resolve, it returns `found: false` with no `billId` and performs no bill lookup. If resolution succeeds, it performs an exact `congressBill.findUnique` lookup. A missing row returns `found: false` with the canonical `billId`; this is a miss in the Capiro local database only, not evidence that no such bill exists at Congress.gov.

For a found bill, the handler returns selected bill fields, at most 15 recent action rows, at most 15 bill roll-call votes, all locally linked governing rules, and at most 3 votes per linked rule. It selects no action, vote, or rule-link row IDs, no sync timestamp, and no source version. `generatedAt` is response-generation time; `statusAt` and action/vote dates are event dates. None is a source-observation or sync-freshness timestamp.

## Envelope claims

- An unresolved input is `needs_input`; `congress_bill` is `not_queried`. A canonical local miss is `not_found_within_scope` with an exact-ID, local-database scope and zero rows. Mismatched or contradictory payloads remain unverified.
- A found bill has a complete local exact-key observation with the canonical `billId` as its only record provenance. Actions and bill votes each have a separate local query observation. Governing-rule links are a separate uncapped local query observation; each linked rule has a separate vote observation.
- A list shorter than its query cap is complete for that local query. A list exactly at its cap is partial: matched count and continuation remain unknown, and truncation records a *possible* local result cap. A malformed collection is unknown. These classifications make no claim about upstream inventory or sync completeness.
- Rule status remains in the exact legacy payload. A missing status for the bill or a linked rule prevents an overall `succeeded` outcome. No row ID is fabricated for actions, votes, or rule links. No source freshness is inferred.
- The opt-in observer returns the same legacy object. A call rejection propagates the same thrown value and produces no observation. An observer exception cannot alter a successful legacy result.

## Gate status and residual work

Focused adversarial tests were authored for the handler's unresolved and exact-miss branches, found/capped/malformed data, source scope, provenance, observer failure, and rejection identity. Per the resource instruction, Jest, typecheck, build, database, Docker, browser, and provider checks were not run. Repository diff checks are the only local gate for this slice.

This mapper is not connected to live model behavior. Before any runtime adoption, review model-visible compatibility, source sync freshness, the intended treatment of capped result sets, rule-status availability, and whether the local-database scope is sufficient for any model-facing absence wording. The adapter's request resolver mirrors the handler solely to verify scope; keep both aligned if bill parsing changes.
