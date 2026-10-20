# Original-generation terminal accounting

Local source successor of `eeb748884bab5465d36682b6fe7cbfe43a7ac8d3`.
This is source preparation, not deployed authority or native qualification.

The private initial-generation path now accounts for a genuine retained typed
`needs-information` or `refused` outcome without creating Strategy or Planner
outputs. The exact distinction and original bounded retained evidence stay in
the existing job's private input. Public polling retains the existing `failed`,
`result: null`, `OBJECTIVE_GENERATION_FAILED` projection and exact safe message:
`This Objective strategy could not be generated.` No provider issue text or new
question lifecycle is exposed.

## Transaction and replay

`ObjectiveCanonicalTerminalService` reads the original admission, accepted Meri
run and published request under the scoped job lock. It checks current native
identity/client read authority and a distinct current terminal-accounting grant.
The genuine retained-result call occurs outside database transactions and has a
three-second bound. The final transaction locks the same job again, compares
the original association, publication and input, verifies the typed result, and
establishes absence of the normalization ledger, producer ledger and reserved
Strategy row. The existing Strategy completion path uses the same original-job
fence. A single compare-and-set changes the original running job to failed and
stores its terminal record and safe receipt together. Current authority is
checked before and after the write; release failure rolls the transaction back.

The CAS retains the original claim and attempt. It does not reset a deadline,
mint a worker grant, dispatch a model, create a new request, advance a canonical
pointer or call either product writer. Original completion must have occurred
within its original issuance/request/effect window. Later bookkeeping and
historical replay use fresh current accounting/read authority without requiring
the old effect grant to remain live. An already committed Strategy winner is
returned through the existing saved-generation verifier. An already committed
terminal winner is reconstructed from its original evidence, without new owner
I/O or changed timestamps. Historical Planner ACK replay remains unchanged.

The private record is append-once by application locking/CAS convention in
existing `sp_draft_job.input`; this slice adds no database immutability trigger,
schema or migration.

## Private routes and authority

With the existing `/strategy-api` global prefix:

- `POST /strategy-api/internal/objective-canonical/generation-terminals`, 201.
  Closed body: `{ "schemaVersion": 1, "generationJobId": "<UUID>" }`.
- `GET /strategy-api/internal/objective-canonical/generation-terminals/:generationJobId`, 200.

Both use private/no-store responses. They resolve all original run, consent,
actor and custody identities server-side. Caller-selected outcomes, locators,
bindings or actor IDs are refused. Authority phases are `terminal-account` and
`terminal-read`; the real workload verifier still defaults unavailable. No
credential issuer or live trust is introduced here. Missing evidence and an
unproven failed row remain 503/unconfirmed. Current denial is 404, conflicting
request identity is 409, malformed input is 400. None proves no prior write or
authorizes an automatic retry.

Successful private observations are closed by the service's returned variants:
`applied` carries the existing saved-generation receipt; `not-applied` carries
the original generation job ID, private outcome, terminal receipt ID/hash/time
and unchanged public Objective failure receipt. These are private accounting
responses, not new public Objective state or canonical application ACKs.

## Deliberately unavailable generic outcomes

The pure record/CAS kernel retains four distinct outcome labels for an eventual
genuine observer. Production admission currently supports only the two typed
outcomes above. Meri has no atomic original-generation/issuance/terminal-event
reader that also excludes a concurrent `CAPTURING`, `UNKNOWN` or `PUBLISHED`
completion. A failed/cancelled event, cancellation request, task lifecycle label,
missing receipt or expiry is insufficient. Consequently generic `failed` and
`cancelled` publication and replay remain unavailable. Their remaining owner
dependency is explicit; synthetic kernel fixtures do not establish that proof.

The private regeneration request/result is a separate version and remains
excluded here. Meri's unchanged capture descriptor has twelve fields; its
typed result has eighteen and retained-reader observation seventeen. This
slice does not change those schemas or alias their distinct hash domains.

## Validation boundary

Focused fixtures exercise the actual pure codec/kernel and actual service over
declared synthetic current-authority, retained-reader and database ports. They
cover original identity, late accounting, replay, competing success, stale
claims/source, exact safe projection, CAS/release rollback and unknown evidence.
The existing success codec is included because its immutable verification code
is shared. Source stripping is not a semantic TypeScript compiler, framework
HTTP test, native PostgreSQL/RLS test or genuine SDK/provider-custody test.

The exact local commit/tree, per-file hashes, raw focused output, measured child
exit/cleanup and independent review are recorded in the task-local
`objective-canonical-terminal-evidence` handoff. Native ACL STOP, real authority
and reader mounting, full compiler and runtime integration remain separate
gates. No push, live migration, deployment, provider call or paid run is part of
this slice.
