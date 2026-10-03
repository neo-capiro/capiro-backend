# C2 clock and provider release — deployed and verified

The exact API `5b086a6b47ffce5aa1b93bfe38f9c7b96e297642` image
`sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd`
is served by task definition 519. Orchestrator
`fb17c7ebfa010ce964919068f61830cb78ca620d` image
`sha256:2b3ac021d0e5149478bb480c3ed572151bd8b03e08b2a74fd1227af829a06436`
is served by task definition 115. Exact current tasks and load-balancer targets
were healthy at 2026-10-03T21:03:52.187Z. An ordinary Pat/T1 standard-user request
returned HTTP 200 with the new API source; its temporary session was revoked.

The user approved the original exact release packet. Its original one-hour
snapshot had expired by the response, so a new current schema/image/configuration
readback refreshed only `preparedAt` and `expiresAt`. Independent review confirmed
that all scope and candidate fields were identical. The original approval and
packet remain preserved. The refreshed packet's inherited pending-status text is
historical input; the separately bound approval and deployment receipts record
actual authorization and completion. No expiry check was bypassed.

Models, configuration, capacity and schema were unchanged. WebVNext388 remains
`78ad5805679a3045b1fc10fb19beafa7f76e4e64`; nightly task136 still pins the earlier
guarded memory image and the broad worker remains disabled. Rollback task
definitions 518/114 retain the previous compatible API/orchestrator images.
The schema read verified ledger609, all608 prior checksums, both ready additive
indexes and absent retired tables; it executed no migration. Its utility task
stopped and its definition became INACTIVE.

The served verifier's v2 preparation had a readback-reporting issue identified
before execution. V3 preserves exact requested/returned task cardinality and
identity. Old-task reads for API/orchestrator returned zero requested/observed
tasks; this does not prove a broader historical census. Web old-task state was
not checked, and is explicitly null. V2 was not executed; both files remain.

This release is not a benchmark result. No provider call, conversation creation,
journal mutation or fixture mutation occurred in served verification. The
separate native setup/capture checkpoint records any later operations and
limitations. Original acceptance counts and human grading remain separate.
Private task definitions and secret values are excluded. `artifacts.json`
records exact archived bytes; original build qualification remains in the
[release preparation](../c2-clock-provider-release/README.md).
