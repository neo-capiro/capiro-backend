# Core roster release packet — 2026-10-19

This packet prepares the exact Core source, task configuration and roster route for coordinated review. **Deployment and the shared-listener priority changes remain held.** A documentation commit on `codex/core-roster-release-plan-20261019` is never an image source pin.

The parent relayed trusted human approval at **2026-10-19 20:21 UTC** for **$6 total: one Core attempt up to $4 and one frontend attempt up to $2**, within the **$616 overall cap**, with a bounded rollout. Root owns the approved Core upload, project pinning and single build attempt. This spend approval does not resolve the concrete task/configuration review or the separate shared-listener approval and ownership hold. No deployment permission is recorded here. Do not infer upload, build or deployment success from the approval; execution receipts must establish their actual outcomes. No automatic retries are authorized by the one-attempt budget.

| Input | Frozen value |
| --- | --- |
| Core source / PR98 | `50475125275853299798fc40f8cb119f0b865464` |
| Core tree | `c01138fed2e0e89e50f0f54f35c0ff4d4415c9b4` |
| Core archive | `core-50475125275853299798fc40f8cb119f0b865464.zip` — 43,408,386 bytes |
| Archive SHA-256 | `1e8d6874a99b7224513b0d2f9d92a5c5eb027f3160f38561b5049acc3bb4c17b` |
| Frontend draft PR111 | `e6180219b589ae8fced7155d1c451840c8663d94` |

The earlier frontend main archive at `5cd5f20d0f2919dce915a67a46487ce81f3e4f15` is not the successor build input. The frontend lane must qualify PR111 and the exact source/origin admission pair; source allow values remain blank until that review. Neither a branch name nor an image tag substitutes for an immutable source and digest receipt.

The Core inventory contains all 98 PRs and proves **every exact PR40–98 head is included**. In total, 87 heads are ancestors. Eleven older exclusions match the integration ledger: #2/#3 alternative bootstrap, #19 superseded by #45, #25 conflicting generic preview, #28 inactive proposal, and held cleanup #29/#30/#32/#34/#36/#39. The cleanup proposals are not blanket-superseded. No further feature merge is required for this frozen source packet.

The single Core build started at **2026-10-19T20:26:49.178000+00:00**, ID **`capiro-preview-first-chat-core-build:3049e163-298d-4fc4-8dbd-9e6bc87eb057`**, using immutable S3 version **`TDiU.O1kGG_gMyr8nkAQz5CkQKTY_VPl`**. [BUILD-RECEIPT.json](./BUILD-RECEIPT.json) records the actual upload, project verification and StartBuild outcomes. This does not qualify an image or authorize deployment.

Read the packet in this order:

1. [Source receipt](./source-receipt.json) and [roster source evidence](./ROSTER-SOURCE-EVIDENCE.md): exact source, archive verification and application boundaries. The archive's 6,304 files match their Git blobs. Stage 1 `090000` is included; held `100000` is absent. Source inclusion permits no migration.
2. [Build plan](./BUILD-PLAN.md) and [build requests](./build-plan.json): frozen inputs and the owner's bounded execution sequence under the 20:21 approval and exact attempt limits. Unresolved execution outputs require actual receipts.
3. [Task diff](./task-diff.json): proposed immutable image, `RELEASE_SHA`, `PREVIEW_NATIVE_GETS_ENABLED=true` and `CORE_ROSTER_PREVIEW_ENABLED=true`. Preserve the observed 512 CPU / 1024 MiB, one desired task and all unrelated settings. Registering/updating a task remains held for concrete review; no whole-stack deployment, SQL, grants or additional Meri activation is included.
4. [Route plan](./ROUTE-PLAN.md), [exact requests](./route-plan.json), [listener snapshot](./listener-before.json) and [offline verification](./offline-route-verification.json): eleven priority-only relocations, two exact roster rules and DNS-last ordering. These requests remain proposals, not permission to execute.
5. [Meeting follow-up](./MEETING-FOLLOWUP.md): separate feature and qualification limits; this roster release is not meeting-route activation.

The offline model passed **5,040 non-roster and 630 roster requests**, preserving all modeled existing rule identities/actions and admitting only the intended roster request. It does not prove live authentication, ALB normalization/propagation, TLS, query validation, browser behavior or runtime compatibility. Release acceptance still requires the exact candidate image/configuration and positive/negative native-authority evidence, plus the matching frontend source/origin pair.

Existing Core rules P1–3 and Meri rule P4 remain unchanged in the route proposal. All priorities 1–15 are occupied, and no narrower valid alternative preserving every current rule was demonstrated. Only old P5/P7 carry `ManagedBy=manual-alb-rule`; absent tags establish no other ownership. The original preservation constraint remains in force until the shared-listener change receives explicit separate approval and ownership is verified.

Rollback must retain the new roster guard after removing the new allow rule and DNS alias. Restoring priorities immediately conflicts with that guard and risks shared-route fallback. See the route plan for the separate, later cleanup decision.
