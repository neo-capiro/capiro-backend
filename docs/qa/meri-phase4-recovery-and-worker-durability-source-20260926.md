# Phase 4 recovery contract and worker durability — local qualification

Date: 2026-09-26

Branch: `integration/meri-provisional-346-20260925`

## Outcome

This checkpoint closes two local source gaps without activating Phase 4:

1. Native worker run reservations are durable across a container restart on the owned mounted home and remain present until the signed exclusive retention horizon.
2. A dormant, purpose-separated status/Stop command and receipt contract, bounded API transport/repository boundary, append-only persistence projection, and default-off worker endpoint now exist for authoritative recovery work.

The recovery code is not registered in the API module or scheduled reconciler and the worker feature remains default-off. No release image was pushed, no deployment occurred, and no production request was made.

## Durable reservation and single-writer source fence

- The gate bearer binds `after < reconciliationNotAfter < retainUntil` with the same seven-day maximum retention span on API and worker.
- Guarded worker mode refuses SQLite memory mode, default-path/open fallback, and startup without `HERMES_HOME=/opt/data` mounted.
- The patched native idempotency table persists `retention_until`; positive-horizon rows cannot be pruned by an old acknowledgement timestamp and are removed only at the exclusive horizon.
- One built-image container reserved a run on an owned volume and a second container recovered the exact fingerprint. A changed fingerprint conflicted.
- Worker lifecycle state persists a stable ECS `clientToken`, deterministic token jti/time/authorization inputs, access point, and task definition before RunTask. A distinct lease id changes on takeover and fences every progress/final/failure write.
- The crash-window unit test blocks the first replica at the task-ARN write, advances a second replica past the stale threshold, and proves both RunTask inputs are identical and map to one task. The real local-Postgres suite separately proves concurrent cold-scope callers launch one worker.

## Dormant recovery contract

- Commands bind exact dispatch identity, worker route/generation/credential, action, operation id, attempt nonce, method, path, request-body digest, key id, and exclusive time window.
- Receipts use a separate HMAC domain, key id, and secret; bind the exact command token and native response digest; and normalize only reviewed status/HTTP combinations.
- `not_found` and missing/transport receipts remain `UNKNOWN`. `stop_accepted` is nonterminal. Only a signed terminal observation is terminal.
- Canonical verification rejects duplicate, unknown, reordered, route-mutated, key-id-mutated, cross-purpose, and same-secret inputs.
- The append-only migration anchors retries to the immutable dispatch/worker identity, stores command and receipt key ids/digests, forces RLS, closes ACLs, and grants no runtime writer.
- The API boundary copies exact bytes and immutable key snapshots before any await, limits commands to the key/reconciliation/retention horizons, rejects command/receipt secret reuse before transport, verifies the exact native response, and persists only authenticated claims.
- The API transport resolves an exact retained HTTPS origin and native bearer, sends only the native authorization plus one recovery-command header, follows no redirect, retries nothing, and rejects missing/duplicate receipts or response bodies beyond 64 KiB.
- The privileged repository re-verifies against the database clock and immutable operation/nonce/key identity under `meri_phase4_authority_owner`; `capiro_app` is rejected and prompt/request bodies are never stored.
- With `MERI_PHASE4_RECOVERY_V1_ENABLED=1`, every native status/Stop request is authorized before run lookup or Stop effects and the exact native response bytes are signed. Startup validates route/key binding, current key windows, distinct secrets, and equality with the native API key before opening the listener. With the flag absent, native behavior is unchanged.

## Evidence

- Worker lifecycle/token suites: 12/12 focused tests passed.
- Real local-Postgres provisioning fence: 4/4 passed.
- Recovery contract/boundary/repository/transport/migration: 5 suites, 39/39 passed.
- Claim source: 3 suites, 26/26 passed; claim and recovery targeted TypeScript configs passed.
- Python overlay: claim 11/11, tool view 14/14, pinned archive 1/1.
- Python recovery protocol: 11/11 passed, including the shared TypeScript/Python golden vectors.
- Node image guardrails: 2/2 passed.
- Fresh built image: `sha256:3d7529594368684ebbd31be864f28c6fb699ce7aa200b8861056e94456307236`, pinned to upstream commit `7a963716b81be13ba513d4f127633b7da493aff2` and carrying all three overlay labels.
- The built image's exact 15-entry overlay manifest passed `sha256sum -c`.
- The follow-up native reservation/absence authority passed 37/37 selected worker tests and ten consecutive two-connection reservation-versus-seal races. Its fresh image is `sha256:534ae5714696831a65b4f891c388cfd4587c6f9d2035ea24caff22088200e540`; see [the focused receipt](meri-phase4-native-reservation-seal-source-20260926.md).
- The next default-off [signed reservation endpoint](meri-phase4-reservation-recovery-endpoint-source-20260926.md) passed 42/42 selected worker tests and a real internal-network listener proof. Its exact 16-file image digest is `sha256:247f1ba5b8b04fa5d79157a8c26cfc44d34485dc51a640a1a433167a26a8d260`.
- The disposable internal-network image proof passed with no host ingress or external egress. Concurrent transitioned claims still preceded provider/memory/broker effects; UNKNOWN, rejected, and Stop-during-claim cases produced none. Every native status/Stop call used a fresh signed command and exact signed response receipt; repeated status and repeated Stop produced no additional provider/broker effects.
- Recovery migration executed to COMMIT in an isolated Postgres database after applying its required hardened PUBLIC-routine baseline. The temporary database, roles, network, and empty volume created for that replay were removed.

## Fail-closed activation blockers

A clean replay of the complete migration history stops at the earlier route-operator migration because the repository's inherited PUBLIC routine privileges are not yet on its accepted baseline. That is a real deployment prerequisite, not a test bypass.

Activation still requires the API reservation command/receipt peer, module/caller registration, authority-fenced late-ID/absence transitions, reconciliation ownership and scheduling, all-ingress claim/recovery routing, broker-effect idempotency receipts, credential custody and rotation, production EFS/single-writer/topology evidence, rollback rehearsal, Phase 5 evaluation, Phase 6 gates, and explicit deployment GO. The follow-up [generic terminalization fence](meri-phase4-terminalization-fence-source-20260926.md) keeps unbound `prepared`/`claimed` intents and the stuck-pending sweep nonterminal; only legacy/no-intent or authenticated `sealed_absent` paths may use immediate terminalization.
