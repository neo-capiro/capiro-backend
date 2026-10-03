# C2 clock and provider release review

The proposed API and orchestrator images passed native builds, packaged checks and independent technical review. They have not been deployed. [Versioned evidence](https://github.com/neo-capiro/capirov2/blob/5a1dc752a7013f285c99fe485c4fd25e5c78d8df/docs/meri/releases/2026-10-03/c2-clock-provider-release/README.md).

Packet fingerprint: `86bdd03aa44b2cb8c5170671a0eab3055c716c82249ddb9b1a900ec05fd1ae0b`. Expires 2026-10-03T21:52:50.872Z.

| Service | Source | Exact image digest | Current rollback digest |
| --- | --- | --- | --- |
| api | `5b086a6b47ffce5aa1b93bfe38f9c7b96e297642` | `sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd` | `sha256:1a4aef121151bb5da7f70417539ece2faff392842809e6b557370c2d6cf8a49d` |
| meriv2-orchestrator | `fb17c7ebfa010ce964919068f61830cb78ca620d` | `sha256:2b3ac021d0e5149478bb480c3ed572151bd8b03e08b2a74fd1227af829a06436` | `sha256:53b06f768d8a26a8a5c6124f0f7bb55a0e2117fde050706360c6108c98887faa` |

The release adds the qualified original-fixture clock and guards that bind native capture pricing to final provider request bytes, output limits, endpoints and Standard service tier. The orchestrator source differs from the API source only by a test correction and evidence; production code is identical.

The full native orchestrator run passes 1552 tests, with two existing live tests skipped. Provider-focused tests pass 159/159; actual local Prisma/PostgreSQL clock tests pass 22/22. The fresh production schema read verifies the unchanged 609-row ledger and both ready indexes. The original failed native test and correction remain preserved.

Promote API first, then orchestrator, and verify the exact healthy pair. Preserve models, provider configuration, feature flags, roles, network and secret references. WebVNext388, guarded nightly136, the disabled broad worker and existing schema stay unchanged. Rollback uses the current API517/orchestrator113 images above.

This packet includes no paid captures, fixture binding, budget installation or journal mutation. Original benchmark acceptance remains 0/75, CD 0/7 and CW 0/8. Subsequent C2 captures use the existing authorization and remaining budget after their own admission checks.

[Full packet and operation order](clock-provider-release-packet-refreshed.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/5a1dc752a7013f285c99fe485c4fd25e5c78d8df/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires: “Qualification is an explicit **human-reviewed attestation**.” The human has approved these exact images. This successor refresh changes timestamps only; the original packet and approval are retained in the linked refresh receipt.
