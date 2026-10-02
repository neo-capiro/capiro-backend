# Approved-memory local fixture composition

`createApprovedMemoryFixtureRuntime` composes the actual candidate and canonical
store owners. It creates MA510 first, then 509 newer supporting memories. The
frozen fixture, source-map hash rules, capture trust guards, and generic owner
availability are unchanged. A supporting record is not a new frozen acceptance
case or a replacement expected response.

For a bounded set of already-approved frozen sources, supply `sourceIds`, for
example `['MA1-v2', 'MB1']`, instead of `distractorCount`. The same canonical
approval, current authority, readback and retirement owners run for each source's
actual client. Selection rejects pending, revoked, superseded, unknown and
non-memory sources before any operation. The manifest's availability stays
unchanged. Actual allocated item IDs and row versions remain authoritative.

This selected-source composition qualifies the approved/current prerequisite of
case01 only. The logical name `MA1-v2` does not prove a physical version2 or a
MA1-v1→MA1-v2 supersession chain. Case01 remains NOT_RUN until the excluded
pending/revoked/superseded fixtures, guarded supersession owner, current source
readback and trusted capture are composed and executed. Do not activate a frozen
revoked source through this entry point or relabel an approved row as superseded.

Supply a validated fixture manifest with an instance UUID, the application's
`MemoryCandidateService`, `MemoryStoreService`, `TenantContextStore`, tenant
transaction port, `clientMemoryAllowed`, and configured proposer/reviewer UUID
resolvers. Run the composition only inside an owned disposable local database
transaction with isolated provider sinks. The explicit fixture namespace and all
three governed-memory switches must be armed in that local process. The runtime
has no default database configuration or public route.

`createDataset()` invokes real proposal and guarded canonical approval for each
record. Approval checks exact pending content/version and current membership in
its locked transaction; ordinary authorization, audit and durable outbox still
run. A retry reads the existing canonical binding. It never overwrites foreign,
changed or retired content. A failed approval may leave an owned pending proposal;
a failed post-approval read is marked `unknownCommit` and requires actual readback.

The returned binding distinguishes `proposedItemId` (the manifest's prospective
UUID), `candidateId` (the deterministic fixture candidate) and `physicalId` (the
actual allocated canonical item). It includes candidate/item row versions and
content/ownership hashes. Do not put the prospective UUID into a LIVE source map
as if it were the actual item. Capture must bind the actual item using its own
trusted ownership and authority checks. These receipts explicitly say
`liveAcceptance: NOT_RUN`.

`inspect(logicalId)` verifies current canonical state and authority.
`retire(logicalId, priorBinding)` uses the source-owned guarded revoke operation,
retaining the approved candidate, revoked item, transition audit and cleanup
intent. It is not physical deletion. A retired instance cannot be seeded again;
create a new instance UUID. Disposable test cleanup rolls back the enclosing
transaction and independently proves that the random schema is absent.

## Qualification

Run ordinary definition checks with:

```powershell
node --test evals/meri/live-v1/tests/approved-memory-runtime.test.mjs
```

For the opt-in source integration test, set `MERI_APPROVED_MEMORY_PG_CONFIG` to an
absolute private JSON configuration path, then run:

```powershell
node --test evals/meri/live-v1/tests/approved-memory-runtime.postgres.test.mjs
```

The config must explicitly name `127.0.0.1`, port `55433`, `database`, `user`,
`password`, absolute `dataDirectory`, and scope
`owned local disposable test cluster; no AWS connection`. Do not print or commit
it. The harness verifies actual owner/address/port/data directory before DDL. It
never falls back to `DATABASE_URL`, and absent config skips the PostgreSQL suite.
It loads current TypeScript services through the existing ts-node installation,
uses actual Prisma ORM/SQL, and replaces only the post-commit embedding/projection
fast path with an inert owned sink. The durable outbox remains real.

This narrow integration uses minimal local schema DDL. It does not claim a full
migration replay, production RLS qualification, live Meri recall/citations,
authenticated browser capture, or completed case 12. Those obligations remain
separate and require the actual application/capture run over proven fixture IDs.
