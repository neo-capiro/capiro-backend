# MeriV2 Phase 3 Acceptance — Settings Shared-Memory Review Lifecycle

**Repository:** `neo-capiro/capirov2`
**PR:** `#679`
**Branch:** `agent/meriv2-world-class-closeout`
**Implementation:** `51bcb642851bbfcdc452908c94a830afd6a07733`
**Moving baseline:** `main@057f5480a46f9ba9acf9296a9cc876b609593832`

## Acceptance result

**PASS.** Firm and client Settings edits create review candidates and do not mutate active steering context. Personal files retain the immediate owner-only path. Client ethical walls are checked before a proposal is created. Pending state survives reload and the UI says “Submitted for independent review,” not “Saved.”

## Proven scenarios

| Scenario                  | Expected                                                      | Result |
| ------------------------- | ------------------------------------------------------------- | ------ |
| Firm edit                 | Candidate created; active item unchanged                      | PASS   |
| Client edit               | Server-bound client and wall enforced; candidate created      | PASS   |
| First shared file         | Candidate only; no active orphan                              | PASS   |
| Personal file             | Immediate owner-only save; spoofed slug ignored               | PASS   |
| Approval                  | Exact canonical type/slug/title/sections activated atomically | PASS   |
| Reload                    | Pending candidate shown; active sections retained             | PASS   |
| Save wording              | Shared submission never labeled “Saved”                       | PASS   |
| Failure boundary          | No success state on rejected/failed mutation                  | PASS   |
| Program Element isolation | No Phase 3 changes to Program Element/defense-budget paths    | PASS   |

## Validation

Promotion workflow `30530501216`:

- API typecheck: PASS
- Web typecheck: PASS
- API regression matrix: 5 suites / 31 tests PASS
- Web result contract: 1 file / 2 tests PASS
- Moving-main reconfirmation: PASS
- Program Element forbidden-path assertion: PASS

Normal PR checks on `a3f406388cbf65d9e3ab4e023325f2711eaefe4a`:

- `ci-pr` `30530842082`: PASS
- `meriv2-evals` `30530842133`: PASS
- `engagement-trust-boundary` `30530842075`: PASS
- `funding-opportunities-ci` `30530842064`: PASS
- `legiwatch-ci` `30530842063`: PASS

## Rollback

Revert `51bcb642` while retaining pending candidates, active controlling items, additive schema, and audit history. Do not activate pending proposals as part of rollback. Keep new governance flags dark and do not rewrite published history.

No production deployment, migration, backfill, flag activation, AWS action, merge to `main`, or customer-data operation was performed.
