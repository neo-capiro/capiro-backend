# Workspace brief-copy native qualification handoff

The exact published [PR2473](https://github.com/neo-capiro/capirov2/pull/2473) source `76f50b2667d06a121b2dd772abc9d64adb556c36`, tree `d6e615533e4c36970779962b1391af90e5576314`, passed the bounded native PostgreSQL qualification. This packet changes no product source, schema, migration, receiving contract, or frontend behavior. It carries the independently reviewed [PR2472 receiving contract](../prospect-brief-workspace-copy-20261013/RECEIVING-CONTRACT.md) unchanged.

The fresh official cached Prisma 5.22 client was generated from the exact new Workspace schema, and the exact additive copy migration was applied to one owned synthetic database on the existing PostgreSQL 16.15 container. Strict Workspace type checking and the actual Nest build passed with that client. The actual emitted Documents controller/service, shared authority functions, Collaborators service and Versions service then passed [19 native control groups](evidence/native-results.json): 922 recorded native query events, 44 BEGIN, 24 COMMIT and 20 ROLLBACK. These counts include fixture and direct-service queries. Two actual request sessions were observed waiting on the draft row lock; conflicting saves produced one success and one state conflict. Exact historical Core source rows were preserved.

[Independent acceptance](INDEPENDENT-BACKEND-REVIEW.md) was committed separately at `16d561275bd0e1131f045bd965f2f46ad749d1cf`, tree `4fd44ee54a4c1a441767b7d7ae79d605a9d762c2`. The reviewer reviewed the evidence rather than rerunning the native fixture.

Owned-resource removal is verified; historical preservation acceptance remains qualified by the unresolved first comparison failure. The owned database and private runtime configuration were removed. The [cleanup receipt](evidence/owned-target-cleanup.json) records unchanged unrelated database/role catalogs and container configuration. Only owned generated outputs were inventoried and retired; borrowed caches remain unchanged. [Source preservation](evidence/source-preservation.json) confirms all 26,574 base mode/blob entries are exact.

## Dependencies and overlap

| Lane | Exact source | Relationship and remaining gate |
| --- | --- | --- |
| Workspace copy/save | PR2472 `e0446e3f865899b03d654657db903cea54dfaf0a` | Existing canonical owner and contract; native qualification adds evidence only. |
| Cached comment calendar | PR2470 `46aa2164c299151225c6cdb9f3cc565fee347657` | Product source unchanged; comment deadline remains distinct from authoritative effective dates. |
| Paired Intelligence ownership | PR2473 `76f50b2667d06a121b2dd772abc9d64adb556c36` | Frozen receiving source used for the native run. |
| Identity/LDA/mapping/context ownership | PR2474 `e19ec92e1c40e92d6fe48803df57ec3b51ec8e8c` | Preserved separately and queued for an ordinary receiving integration after this publication. |
| EngagementService reporting | Protected task `task01a12dc9-21a3-7062-908e-b6fabc37c027` | No branch/body inspection or modification; no ownership claim. |
| Deployment and authentication | Separate shipping lane | Live Clerk/JWT, RLS/grants, full AppModule, deployed ABI/image, provider execution and rollout remain unqualified here. |

No historical migration sweep or PR2450 authority rerun was performed. Native identity used a deterministic fixture adapter at TenantGuard and the existing local owner role. Legacy PATCH/DELETE fences used HTTP; restore used the actual VersionsService directly. These limits are explicit in the native receipt.

## Preserved failures

Attempt 0 stopped before HTTP controls on the fixture field name `invitedBy` versus `invitedById`. Attempt 1 passed 15 groups and then hit legacy PATCH 500 because the selected baseline lacked the existing manually migrated `ws_source_action` table. Applying the exact existing table/function/trigger statements to the owned database, excluding GRANT/REVOKE, produced the final 19/19 pass. No source repair or 409 contract change was needed.

The first cleanup dropped the owned database but failed its post-drop preservation assertion. Its actual in-process mismatch was not persisted, so the cause is unproven: neither a comparison-tool failure nor a transient unrelated resource change has been established. Immediate read-only comparison found no unrelated catalog or container difference; strict target-absent recovery then passed and removed the private configuration. These later equal snapshots establish the final state, not the state at the failed assertion. Owned-resource removal and final-state preservation are verified, while the initial preservation incident remains unresolved and cleanup is not presented as unconditionally closed. The failed attempt and recovery evidence are both retained.

The first output inventory assertion assumed 660 files. The default Nest output contained 660 emitted source files plus `.tsbuildinfo`; correcting that count required no source change or rerun. No output had been removed before the failed assertion. All failed and final native traces, commands, receipts and consumer shutdown evidence remain in this packet.
