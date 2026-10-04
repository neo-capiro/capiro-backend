# C2 capture-contract release deployed

The exact approved API and orchestrator source `4f0253874357c272fda1ae2a5271ee4af645f0bc` is deployed and healthy. API revision521 serves `sha256:23f529da3c1c00d401968811575dc075bced6c60669baa9a09e9c23575c9c452`; orchestrator revision117 serves `sha256:1c491a5ac46ea320195fe8ab367322ad2ebbd0949d69530b5ccfba2de84eb491`. [Served readback](capture-contract-served-readback.json) was observed at 2026-10-04T00:23:40.773Z.

The human explicitly approved the exact packet fingerprint `5d67f443a71180e7aa49e775f3f979a585348d5b6480a7e83b76432bef7bfbdf`. API was promoted and verified before orchestrator, through the repository release operator. All current task digests, configuration fingerprints and ALB targets passed; ordinary Pat/T1 identity returned200 with the new API source and its owned temporary session was revoked. [Approval](capture-contract-human-approval.json), [API receipt](api-capture-contract-promotion-receipt.json), [orchestrator receipt](meriv2-orchestrator-capture-contract-promotion-receipt.json).

Models, configuration, schema and capacity remain unchanged. WebVNext388, guarded nightly136 and the disabled broad worker retain their previous state. Rollback revisions520/116 retain the compatible prior API/orchestrator images. No cleanup or fixture reset was repeated.

The [immutable qualification](../c2-capture-contract-release/README.md) includes1564 native orchestrator tests,281 focused checks, four combined actual PostgreSQL checks, packaged probes and independent review. This deployment and ordinary identity readback are not original benchmark acceptance. Original Case01 remains failed/uncertain and is not replayed. Original acceptance stays0/75, CD0/7 and CW0/8. No product-provider call, capture, binding/budget installation or journal mutation occurred during this release; separately authorized C2 setup/capture remains next.

The original packet's pending-review fields describe its historical preparation; the separately bound human approval and deployment receipts establish the completed release. Private task definitions and credentials are excluded. The manifest binds exact archived bytes.
