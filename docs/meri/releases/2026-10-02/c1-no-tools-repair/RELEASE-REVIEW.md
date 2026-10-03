# C1 concise-warning release review

## Proposed action

Promote only `meriv2-orchestrator` to the qualified concise-warning image below through the canonical operator, then run the [four served checks and reload](no-tools-served-verification-plan.json). This is a new artifact. The earlier classification deployment, forward452 migration and mailbox-defaults deployment are already complete; none is being requested again. No additional credentials are needed.

| Identity | Exact value |
| --- | --- |
| Source | `cfd0adf0c54776f81f4b4e57c1a43190766e195e` |
| Immutable image | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator@sha256:a53bf1a432f212b8e43be903f766c52ec4a8307d5fce1cbec1bdfbf45196ddea` |
| Manifest fingerprint | `cdae48fbe78e3355f896f5516b6704d30153a8058be3ec5c968d9aa00ae9b762` |
| Prepared at | `2026-10-03T06:48:45.876Z` |
| Valid until | `2026-10-03T07:48:45.876Z` (October 3, 3:48:45 a.m. EDT) |
| Healthy current revision | `capiro-dev-meriv2-orchestrator:109` |
| Rollback image | `sha256:27418fb841c03bc1637949c45d9deda1d4de8fd5be423d05beaf83e5d1025be6` |
| Preserved configuration hash | `3a4fabd2139e347cd8b45192579f2a3fbaaa6fc3678762b5252f727a4461951b` |

[Prepared manifest](orchestrator-no-tools-manifest.json), [preparation receipt](no-tools-release-preparation.json), [candidate-bound qualification](orchestrator-no-tools-qualification.json), and [fresh API/Web readback](no-tools-sibling-readback.json) are archived. Preparation made no AWS writes. API515 and WebVNext388 retain their exact prior healthy baselines and source identities. The operator will recheck account, candidate digest, healthy baseline and full fingerprints before any release mutation. Expired or drifted evidence cannot be forced through.

## Change and evidence

The exact three-bullet capability request ending “Use no tools” currently produces an unrelated source-never-called warning. One production planner file now distinguishes that standalone execution constraint from a factual negative claim. Genuine exhaustive/current-role requirements and failed/partial-source warnings remain. The quoted-text P2 found during independent review is fixed; ambiguous quotes, apostrophes and reporting words remain conservative and may retain a warning. No schema, API, dependency, model or flag change is included.

Qualification on exact source `cfd0adf0c54776f81f4b4e57c1a43190766e195e`:

- 1,494 full-core passes; two existing TODOs; 114 suites.
- 155 focused planner passes and 36 JSON/SSE plus coverage passes.
- 1,502 native ARM64 orchestrator passes; two existing pending tests; 129 suites; TypeScript and build pass.
- 26 exact-source offline passes with zero live provider calls.
- Packaged entrypoint health/authentication, prior classifications, mailbox defaults, concise/quoted/mixed-factual checks, and ECR digest match pass.
- Independent source, build-procedure and archive reviews pass. Full red/green and native build logs are retained in the [qualification archive](README.md).

The canonical Actions run failed at startup with zero jobs; the reviewed build-only CodeBuild fallback succeeded. Qualification is bound to versioned evidence commit `f20692e7f5673cb76a7c7841cd3b0e5e0c234454`. This does not claim the candidate is already deployed or that C1 is accepted.

## Acceptance and rollback

After health passes, use the existing signed-in thread and unchanged model/mode/effort for the exact concise prompt, a genuine exhaustive claim without tools, own native task count, minimal count-only mailbox read and persistence after reload. Capture actual outcomes and timing limits. Prior known/zero owner fixtures and controlled mail-failure/recovery remain valid at their stated boundaries; they do not replace original synthetic permission cases. No customer message content, business writes or memory decisions are requested.

The release preserves existing service configuration and registers pinned rollback/candidate revisions. If a served acceptance failure occurs, retain the result and reconcile live state before reviewing rollback; never replay an uncertain mutation. Retain the already-verified additive452 index. Its ledger remains609 and the migration task/definition are stopped/inactive. API/Web and other services are outside this promotion.

## Approval boundary

Owner approval for this exact manifest is **pending**. The [repository release contract](../../../deployment-prerequisite.md#release-operator-and-safety-contract) says: “`promote` requires an approved manifest fingerprint and exact production/service confirmation.” The previous “Approved” completed the mailbox image. It did not identify this newly discovered defect's image.

After explicit approval, the lead uses the archived manifest and exact fingerprint with `PROMOTE_CAPIRO_PRODUCTION_meriv2-orchestrator`, writes a new promotion receipt, then completes the served checks. C1 remains open until those checks pass. Original75/CD/CW acceptance and file02 readiness remain unchanged.
