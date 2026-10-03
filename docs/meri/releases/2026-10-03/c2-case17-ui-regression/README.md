# Current-image six-proposal UI regression

All six original synthetic proposals remain visible and actionable inside Meri before and after reload on API517 (`f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f`) and unchanged WebVNext388 (`78ad5805679a3045b1fc10fb19beafa7f76e4e64`). The current native build checks, authenticated fixture-owner read, two UI page reads and same-process saved-artifact grading passed. This is a UI slice, not full original case17 acceptance.

- [Result](case17-regression-v2-result.json): `UI_SLICE_PASS`, temporary session revoked, zero provider calls, zero application writes. Three panel-preference writes were blocked by the existing read-only guard.
- [Evidence](case17/evidence.json): SHA-256 `a0fd2d6396987341cc62f2ad10e5f8e49d18752f488c17b7a736f717c642e1c0`. Both rounds show the same six proposal IDs and unchanged owner bytes. Each round returned one API page; no pagination-limit claim is inferred.
- [Saved-image review](case17-regression-v2-visual-review.json): six reload images inspected; all twelve files were hashed, and corresponding initial/reload images are byte-identical. A/B/C show Aster, D Bluehaven, E firm and F personal scope; each shows pending status, its synthetic value, `Source: model extraction`, and a Withdraw action. The visible source kind is checked; distinct-source provenance navigation was not demonstrated.
- Fixture instance `63c7bb50-1971-49df-96b9-c6c94c562078` and recipe SHA `853dbf7f1e839639658e6cb9e2575fd4ef31fccf9d67b339d8ae4894537807d6` are the original fixture. No reseeding, withdrawal, approval or reset occurred.

Collector source `d1bcbf37c714ff1980ff73f9b8c6c34845be7956` includes the [reviewed exact configured-CLI repair](../c2-case17-caller-fix/README.md). The first attempt remains retained there; it failed before sign-in because the prior collector required another IAM user. This new run has its own identity `22175a99-1245-4929-9d3c-4e7e0c058374` and did not erase that failure.

The original prompt was not submitted, the original human rubric is `NOT_RUN`, and decision/error/conflict/role/next-turn-recall variants are not established by these screenshots. Original acceptance remains PASS0/75 and CD0/7. No service deployment or provider-budget reservation was part of this UI regression. Authentication values and the local private crash-cleanup locator are excluded. [Artifact hashes](artifacts.json).
