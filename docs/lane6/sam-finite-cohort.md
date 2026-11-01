# Finite SAM action invocation

This opt-in mode belongs to the existing `apps/api/scripts/ingest-contract-award-transactions-v1.ts` producer. It uses the existing `mapSamAction`, `transactionInput` and `AcquisitionContinuityStore.appendTransaction`; it does not create another producer, dispatch route, qualification writer, schema, grant or ledger contract. Legacy invocations retain their prior behavior. New source requires a new image and independent qualification; the earlier qualified image does not qualify this change.

## Inputs and invocation

`--help` has no file/provider/DB effects. Finite mode requires:

```text
--award-keys-file FILE --award-keys-sha256 SHA256
--evidence-dir NEW_ABSOLUTE_POSIX_DIRECTORY --expires-at UTC_INSTANT
--producer-commit SHA40 --image-digest sha256:HEX64 --run-id UNIQUE_ID --target-id TARGET
[--commit]
```

The cohort file is a UTF-8 JSON array of 1–25 distinct canonical full `usaspending|award|CONT_AWD_...` keys, at most 16 KiB. Its expected lowercase SHA256 binds the exact file bytes, including whitespace. Numeric and leading-zero PIIDs are preserved. Complete own/parent agency dimensions are mandatory; PIID-only values, malformed/unsupported composites and half parents refuse. Duplicate, unknown or mixed legacy flags refuse before any output directory, provider call or DB client. Finite-only `--flag=value` forms refuse rather than falling through to legacy behavior. `--help` is effect-free even alongside other flags.

`SAM_GOV_API_KEY` is required. Appends require **both** `--commit` and `PROGRAM_ACQUISITION_CONTINUITY_ENABLED=true`; otherwise the mode stages source evidence and performs a read-only database validation. Neither an API key nor producer-supplied release/run/target labels grant database authority or source entitlement.

Bounds can be lowered but never raised above these ceilings:

| Option | Default and hard ceiling |
| --- | --- |
| `--max-pages` | 25 total requests; must cover every distinct cohort PIID |
| `--max-records` | 2,500 total returned records |
| `--max-body-bytes` | 2,097,152 per response body |
| `--max-total-bytes` | 16,777,216 across response bodies |
| `--response-timeout-ms` | 10,000 for headers and streamed body together |
| `--task-timeout-ms` | 120,000, also limited by explicit `--expires-at` |

Each distinct PIID receives exactly one planned request: `offset=0`, `limit=100`, one attempt. Redirects fail; 429/5xx responses are retained and fail without retry. There is no adaptive pagination, page-one mode, resume, source fallback or automatic replay. A full 100-record page or a reported total greater than the observed page count is marked `historyIncomplete=true`. A false flag only means that these indicators were absent; it never proves complete history. Provider totals are untrusted metadata. Overall coverage is always `bounded_observation_only`.

## Staging, identity and write boundary

All bounded source pages are staged before a database client is created. Exceeding a body/row/time limit, incomplete transport, malformed source envelope or evidence-write failure prevents transaction admission. Every structurally valid observed record has a page/row disposition, including `staged_not_validated` when an earlier failure prevents mapping. Failed pages retain their bounded prefix when available, with actual request metadata, `responseBodyComplete=false` and artifact size/hash; malformed complete bodies remain distinguishable from transport truncation.

The existing catalog query retrieves all distinct award/key candidates for the requested PIIDs, with a 26th-pair refusal sentinel. More than 25, malformed canonical candidates, or any missing requested full key refuse. Candidate resolution happens before the full-key allowlist check, so a same-PIID alias cannot hide malformed/ambiguous catalog mappings. Successfully mapped out-of-scope rows are counted and excluded. Any other failed mapping or same-action/same-source-clock conflicting canonical payload refuses the entire staged write set. No arbitrary winner is selected for a fork. The original mapper's exact source clocks, numeric obligation lexemes and signed/null money semantics remain unchanged.

One bounded `READ COMMITTED` transaction performs catalog validation, visible prior exact-run-tuple refusal, and all canonical appends. A dry run uses `SET TRANSACTION READ ONLY`. The shared `runPrismaTransaction` bounds acquisition plus transaction execution to at most 15 seconds and to the remaining task allocation, with one second reserved for cleanup. Native statement timeout and one-second lock timeout apply. The existing store receives the transaction client; append/commit settlement is awaited, followed by disconnect. No promise race detaches DB work. There is no table/advisory lock or new right. Existing candidate reads, action SELECT, and canonical append privileges remain prerequisites; the prior-run provenance scan may consume its bounded query allowance and must be checked under the real role/data volume.

The existing store is not task replay protection: a fresh observation clock can append new rows under a reused run tuple. The visible prior-run check and exclusive output directory prevent obvious reuse but do not establish cross-process exclusion. Sole executor custody and unique invocation/run/evidence allocation remain required. No retry occurs after any failure. External reconciliation must precede any separately authorized new invocation.

## Private evidence and outcome semantics

The newly created evidence directory is exclusively allocated, POSIX owner-only `0700`; each file is exclusive `0600`, fsynced along with the directory. Native Windows execution refuses because chmod does not establish a private Windows ACL. The cohort input must be a regular non-symlink file; nonblocking/no-follow open plus an fstat recheck prevents FIFO/device admission. Use local regular storage; the task timer cannot interrupt blocked OS I/O.

`page-N.bin` retains exact **decompressed response-body bytes delivered by fetch**, not compressed HTTP wire bytes or headers. Byte caps apply to this decoded stream. Parsing uses fatal UTF-8 decoding and the existing lossless action-obligation adapter; retained raw bytes are the independent original-body evidence. URLs containing the API credential are never written into receipts or errors. Full keys, PIIDs, raw source content and physical row references remain inside private evidence. Public stdout reports only bounded counts/state/reason and the final receipt filename/hash.

`cohort.json` and `invocation.json` bind scope, run tuple and bounds. Before transaction admission, `write-intent.json` is durably written with `TRANSACTION_OUTCOME_UNRESOLVED` and **null durable counts**. `receipt.json` records normal completion/refusal, actual page statuses/clocks/body completeness, raw artifact hashes, row dispositions, observed mapping counts and provisional physical IDs linked to page/row/source payload hash. Private JSON is capped at 4 MiB. Finalization failure after an append produces unknown/null durable counts and preserves the intent; it never implies rollback. Provisional IDs are not independent qualification members or exact-microsecond persisted-row readback.

The CLI watchdog spans source streaming, DB settlement and cleanup. On expiry it attempts an exclusive bounded `task-expired.json`, then exits nonzero; the prewritten intent survives even if this artifact cannot be written. A post-fsync deadline check also writes this superseding artifact rather than reporting a late completed receipt as success. Neither process exit nor a timer establishes server termination, rollback, or hard cancellation of blocked native work. **The execution owner must separately enforce physical task termination and reconcile any unknown database outcome.** This is a required operational dependency, not a guarantee established by offline tests.

Exit codes: `0` bounded commit/dry-run completion; `1` refusal/failure before uncertain writes; `2` uncertain write outcome; `3` CLI task watchdog expiry. A late helper result may report code 2 if a monotonic deadline expires before the wall-clock watchdog callback. Empty successful runs may report zero observed appends; they establish neither a complete financial zero nor an available qualified population.

Independent qualification remains unchanged: the owner must bind the actual new immutable image, release commit, ordinary DB role/target, SAM entitlement, exact original-source evidence, completed physical population, all 17 persisted fields and exact microsecond clocks. The producer never installs, extends or approves its own qualification. Native SQL/role behavior, external task-stop behavior, source entitlement and live execution are unrun by this source change.
