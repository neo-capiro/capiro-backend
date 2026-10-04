# C2 capture-contract release review

Release the reviewed repair for original capture proposal reads, signed receipt persistence and the admitted budget ceiling. [Versioned qualification and limitations](https://github.com/neo-capiro/capirov2/blob/3c22947463812812b72f4322bca410aec7d91ac5/docs/meri/releases/2026-10-03/c2-capture-contract-release/README.md).

Packet fingerprint: `5d67f443a71180e7aa49e775f3f979a585348d5b6480a7e83b76432bef7bfbdf`. Expires 2026-10-04T01:07:04.586Z.

| Service | Source | Exact candidate image | Rollback image |
| --- | --- | --- | --- |
| api | `4f0253874357c272fda1ae2a5271ee4af645f0bc` | `sha256:23f529da3c1c00d401968811575dc075bced6c60669baa9a09e9c23575c9c452` | `sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd` |
| meriv2-orchestrator | `4f0253874357c272fda1ae2a5271ee4af645f0bc` | `sha256:1c491a5ac46ea320195fe8ab367322ad2ebbd0949d69530b5ccfba2de84eb491` | `sha256:2b3ac021d0e5149478bb480c3ed572151bd8b03e08b2a74fd1227af829a06436` |

The API omits absent clock proof before signing, permits the existing own-pending proposal read under original01/14 scope, and checks the signed receipt against the actual admitted ceiling. The orchestrator records the actual scoped proposal response, including healthy empty results. Missing, partial or failed evidence stays blocked. This fixes the capture path; it does not turn the previous failed run into a pass.

Qualification includes 1564 native orchestrator tests, 281 focused checks, four actual PostgreSQL tests on the final combined source, packaged image probes, and independent review. Two existing live tests remain skipped. The fresh production schema read verifies the unchanged609-row ledger and both indexes. The initial zero-job Actions failures and build-request size rejections are retained; the successful fallback executes the exact reviewed phase commands through a compressed carrier.

Promote API first, verify it, then promote and verify the orchestrator. Preserve service configuration, models, flags, secrets, network, capacity, WebVNext388, guarded nightly136 and the disabled broad worker. Run no migrations or memory cleanup. Rollback retains the compatible current API519/orchestrator115 images shown above.

This release packet includes no paid capture, fixture binding, budget installation or journal mutation. The original Case01 run remains failed/uncertain. The saved22-event journal has no active reservation and $17.866117 remaining under the existing authorization. Original acceptance remains0/75, CD0/7 and CW0/8. After release, Case20 proceeds only after its own existing source, fixture, admission, cost and authentication checks; human grading remains required.

[Full packet](capture-contract-release-packet.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/3c22947463812812b72f4322bca410aec7d91ac5/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires: “Qualification is an explicit **human-reviewed attestation**.” Approval for these exact new images is pending.
