# Case12 API compatibility release

The API image from merged source `478a1826afc7e4d599c66bfe5fb7a9759b0a4582` accepts the empty `inferenceAcceleratorOverrides` field that ECS adds to an otherwise exact task override. All other override values remain checked. [Source and tests](../c2-case12-ecs-compat-source/README.md) retain the independent review, 47 passing regression tests, passing API project typecheck and Nest build, and the broader package typecheck failures in unchanged word-extractor declarations.

The [CodeBuild backup image](build/build-readback.json) passed all 26 required packaged checks. The [real native plan](native-plan/result.json) ran on that exact image and source with zero provider calls or business writes. Its task stopped and definition became inactive. The [fresh schema check](schema/schema-proof.json) confirms ledger609, both reviewed indices and retired-table absence; its owned helper also cleaned up.

The user's repeated approval authorizes this narrow API correction. The [approval receipt](case12-ecs-compat-scope-approval-v1.json) explicitly records that the image digest was unavailable when approval was given. Root binds that scoped approval only to the qualified image from the reviewed source; it does not claim the human separately reviewed a later digest. Promotion uses the existing release operator and then authenticated verification. API527 is the rollback baseline. Orchestrator123, Web390, models, configuration, schema, schedules, original journal and failed captures remain unchanged.

[Qualification and exact artifact pins](release-qualification.json) record the scope and limits. No setup or capture admission is created by this release. C2 remains incomplete; live Case12 setup/capture and original human acceptance are outstanding.

## Deployed verification

The existing operator promoted API529 with rollback528 retaining API527's image. At 17:10:52 UTC, [served verification](deployed/case12-compat-served-readback-v1.json) proved the exact image/source/configuration, healthy API/orchestrator/Web tasks, ordinary Pat/T1 identity and approved-memory list/markdown reads, both old API527 tasks stopped, and temporary session revocation. Orchestrator123, Web390, Nightly136 and the disabled broad worker remain unchanged.

The [registration-only check](helper-definition/executed-once/result.json) proved the exact Case12 helper definition survives ECS registration with the same native hash, then deregistered it. No helper was launched and no budget hold was created. The [fresh native-plan audit](native-plan/current-image-root-audit.json) joined the actual current-image task, raw responses/logs, cleanup and 510 derived bodies. The complete pinned local cost derivation confirms the $0.167280 ceiling for 1,020 requests. These checks do not establish paid setup or live capture acceptance; terminal operator and settlement integration remains open.
