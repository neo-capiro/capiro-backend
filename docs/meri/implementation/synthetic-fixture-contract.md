# Synthetic Meri fixture provisioning contract

Version: `meri-synthetic-fixture-provisioning-v1`

Status: local implementation and release proposal. No shared database, AWS, Clerk, S3, Monday, mail, bill-provider, model-provider, deployment, or live acceptance write is authorized or performed by this change.

## Fixed scope

The provisioner is bound to:

- fixture namespace `meri-foundation-20260928`;
- frozen fixture version `meri-live-v1-2026-09-26.1`;
- the fixture and source hashes in `evals/meri/live-v1/contract-lock.json`;
- T1 `f2d6cf8f-057c-479a-8110-62fe5086d43f` / `meri-foundation-20260928-t1`;
- T2 `52e91176-08f0-4d89-9633-bc212f5bdbbf` / `meri-foundation-20260928-t2`;
- target name `capiro-dev`.

`fixture.mjs`, `source/appendix-f.md`, `contract-lock.json`, and `source-binaries/asset-manifest.json` are inputs and remain immutable. The old fixed-ID Phase 19 seed is not used.

## Artifacts and content addresses

All JSON content hashes use the repository's `stable-json-sorted-keys-v1` semantics: Unicode NFC strings, LF line endings, trailing horizontal whitespace removed, no final newline, recursively sorted object keys, then SHA-256.

1. Source map (`meri-synthetic-fixture-provisioning-v1`)
   - Maps every frozen logical source and the required CD-01–07/CW-01–08 fixture additions to a canonical owner family.
   - Binds tenant, client, deterministic proposed physical ID, owner-native ownership marker, expected payload hash, references, and explicit availability.
   - `contentSha256` covers every field except itself.
2. Dry-run plan (`meri-synthetic-fixture-plan`)
   - Binds the source-map hash.
   - Contains `create`, `replace`, or `noop` only after canonical readback.
   - Captures the exact tenant, physical ID, ownership-marker hash, payload hash, and expected row version used by apply.
   - An offline plan has `authority=offline_unverified` and is deliberately not applyable.
3. Seed receipt (`meri-synthetic-fixture-seed-receipt`)
   - Binds source-map and plan hashes.
   - Records canonical physical IDs and row versions from post-write owner readback, never just seed inputs or booleans returned by a writer.
   - A write whose commit cannot be determined is `unknown_outcome`; later operations stop and the receipt cannot be reset as if complete.
   - `fixtureComplete` remains false. Unavailable sources are listed, even when all available rows were seeded.
4. Verify receipt (`meri-synthetic-fixture-verify-receipt`)
   - Re-reads the canonical owner and compares tenant, owner join, marker, logical ID, payload hash, row version, and, for files, byte hash/size plus a storage-owner receipt.
5. Reset plan and receipt
   - The reset plan binds the exact complete seed-receipt hash and rechecks every manifest join, marker, tenant, physical ID, and seed row version.
   - Reset deletes only receipt-listed owned records, in reverse receipt order, through each canonical owner eraser.
   - Missing records are an idempotent `already_absent`. Changed versions, foreign markers, wrong tenants, and unknown/partial seed receipts block reset. There is no tenant, schema, table, or shared-database reset.

Receipts do not contain secrets. The CLI rejects configuration keys that look like secrets, credentials, passwords, tokens, cookies, database URLs, or API keys. Runtime credentials remain with the reviewed existing application owner.

## Canonical-owner rule

`fixture-provisioning/canonical-owner-adapter.mjs` is a port over existing owner services, not a fixture table. Each owner port must atomically enforce:

- exact authorized tenant;
- exact physical ID and authoritative client join;
- exact fixture ownership-marker hash and logical ID;
- exact expected row version (`null` only for a create);
- owner-native write/read/delete behavior.

An existing foreign row is never adopted, overwritten, or upserted. A collision is `UNOWNED_ROW_COLLISION`. The adapter has no generic fallback store.

Files use `ClientDocumentWriterService.createAttachmentFromBuffer` and its existing storage, scan, indexing, lifecycle, and erasure path. Before upload, committed bytes are read and compared with the immutable asset hash. After upload, canonical attachment readback must prove the same hash and size and provide a storage receipt. A filesystem path is only a local input locator; it is never persisted or reported as a successful download URL. An uploader error or missing readback is not converted into success.

Governed memory maps to canonical `memory_items`/`memory_candidate` owners. Meetings, debriefs, tasks, actions, client facilities, business-development records, and research portfolios are mapped to their named canonical owners and remain unavailable until a reviewed owner port exists. Direct raw writes to bypass encryption, governance transitions, storage, or owner lifecycle are not an acceptable release adapter.

## External availability

Monday, mail delivery/sinks, shared federal bill evidence, shared defense-budget evidence, public-page acquisition, and coworker fault injection are explicit manifest entries. They default to `unavailable` with a concrete reason. They require existing controlled test adapters and explicit owner availability in the release configuration.

The provisioner never reads real provider credentials, performs a real provider/network side effect, invents provider data, or treats an unread source as empty. `MAIL-SINK-51`, CD mail/Monday fixtures, CD-05 action effects, and CW fault paths therefore remain unavailable until their bounded adapters are separately reviewed. Global bill and budget owners are read-only for this tenant fixture unless exact existing canonical evidence is bound; tenant fixture authorization does not authorize mutation of shared global data.

## Dry-run-first commands

Use native Node 22. Every path is absolute. The example contains placeholders and no credential:

    node evals/meri/live-v1/fixture-provisioning/cli.mjs source-map --config C:/review/fixture-config.json --out C:/review/source-map.json
    node evals/meri/live-v1/fixture-provisioning/cli.mjs plan --config C:/review/fixture-config.json --adapter C:/review/canonical-release-adapter.mjs --out C:/review/plan.json

Apply is accepted only with a canonical-readback plan and exact confirmation:

    node evals/meri/live-v1/fixture-provisioning/cli.mjs apply --config C:/review/fixture-config.json --adapter C:/review/canonical-release-adapter.mjs --plan C:/review/plan.json --confirm APPLY_OWNED_MERI_SYNTHETIC_FIXTURE --out C:/review/seed-receipt.json

Verify, reset dry run, then bounded reset:

    node evals/meri/live-v1/fixture-provisioning/cli.mjs verify --config C:/review/fixture-config.json --adapter C:/review/canonical-release-adapter.mjs --out C:/review/verify-receipt.json
    node evals/meri/live-v1/fixture-provisioning/cli.mjs reset-plan --config C:/review/fixture-config.json --adapter C:/review/canonical-release-adapter.mjs --seed-receipt C:/review/seed-receipt.json --out C:/review/reset-plan.json
    node evals/meri/live-v1/fixture-provisioning/cli.mjs owned-reset --config C:/review/fixture-config.json --adapter C:/review/canonical-release-adapter.mjs --seed-receipt C:/review/seed-receipt.json --reset-plan C:/review/reset-plan.json --confirm RESET_MANIFEST_LISTED_MERI_SYNTHETIC_FIXTURE --out C:/review/reset-receipt.json

The release adapter is intentionally not supplied by this local-only change. It must be assembled in the existing API dependency-injection runtime from canonical owner services and independently reviewed. Supplying an arbitrary adapter module is not release approval.

## Server capture-worker handoff

The capture worker should consume the source map and verify receipt by content hash. It must resolve a frozen logical ID only when the verify receipt contains a `verified` canonical row with matching tenant/client/owner/version/hash. It must preserve `unavailable` and `unknown_outcome` states and must not infer fixture completeness from the presence of a source-map entry.

Current records can change fixture facts. Before each case, the worker must perform current owner readback and current authorization checks; a seed receipt is provenance, not perpetual authority. The frozen evaluator, authority gate, exact deterministic assertions, and human adjudication boundary remain unchanged. No receipt manufactured here is a live case PASS or human score.

## Local qualification boundary

The native PostgreSQL test uses only `C:/dev/cap-meri-foundation-evidence/private/local-postgres.json`, validates loopback port `55433`, creates a cryptographically random owned schema, exercises canonical `clients` and `memory_items` shapes with authoritative joins and guarded versions, and drops that schema. It does not use the shared database. Unit tests cover tenant/namespace/marker denial, stable duplicate apply, cross-client reference rejection, changed-version reset fencing, unknown partial writes, source-byte mismatch, subset availability, and actual readback grading.
