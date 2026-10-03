# C1 release review

Two qualified repairs are ready for explicit release approval. C0 is complete. C1 remains open until the deployed behavior passes the final browser checks.

1. **Deploy the response-classification repair.** Source `130824b6c0561069c472b2eb93a0b7cef9217f0e`, orchestrator image digest `sha256:23ccef8051ad386b4cc6635b5e79559b6111b16121537b187bf09cdcca932213`. This removes unrelated financial/bill-status evidence requirements for Office Delta and failed operational searches. Current orchestrator105 is the verified rollback baseline.
2. **Apply one additive mailbox index through the packaged Prisma migration runner.** Source `e1d045d4abe4a7835cb9284508cd287cf1d34d3b`, migration image digest `sha256:5754b5e54f5c81a53ff032310f6af01bdfd67db0c94375a3973369abe786c4d9`. The index covers active messages by tenant and connection. It may briefly block writes, bounded by a 5-second lock wait and 30-second statement limit. A failure or uncertain result stops for reconciliation. The index is retained on application rollback.

Afterward, run read-only browser checks on the existing signed-in account: concise response, scoped task count, known/zero mailbox results, failure wording and persistence. Production cold-I/O improvement is not yet proven.

Passed: 1,492 orchestrator tests (two existing skips), 360 core tests, 26/26 offline cases, 37 API/mail tests, 11 actual local SQL checks, complete fresh452 and451-to452 migration rehearsals, 56 owner-guard tests and36 task-builder tests. Both immutable images passed packaging checks. The earlier five-test candidate failure and fixture failures remain recorded.

The prepared procedures preserve the current API515 and WebVNext388 services, production model/flags, network settings and permissions. The migration uses the existing migration task's four DB secret references; credentials are not copied or requested.

Orchestrator manifest fingerprint: `15a29ec7a10142b038c3266ed0d198813e6c05cc156a89b0d59b40fee3d41c5f`.
Migration plan fingerprint: `4348b68f96a16575fe6541d78e9c4e0c441f5cdf2a05fc28307431f49eaaab21`.

[Orchestrator manifest](C:/dev/main/outputs/meri-c1-20261002/orchestrator-corrected-manifest.json) · [Migration plan](C:/dev/main/outputs/meri-c1-20261002/forward452-task-plan.json) · [Image qualification](../c1-classification-repair/corrected-qualification.json) · [Migration qualification](qualification.json) · [Operator review](operator-review.json).

No service promotion or shared-database migration has been executed. The repository release procedure requires explicit approval of these concrete steps. Prepared manifests expire after one hour; any changed baseline or artifact requires a new review.
