# Core native approval prepared-facts receiver — source only

Base: backend PR86 `b40971b1f8de888687a8fb92fbdf4ff653fe10d3`.
Owner: Core. Meri owns the `run_facts_v1` view and its underlying immutable
`meri_commands.approval_metadata` table. This patch does not change Meri's
table, a runtime grant, `current_admission_v1`, or the original ADMITTED grant
set and transaction lock.

## Read contract

Core reads only `meri_read_delegation_facts.run_facts_v1`, using the existing
facts-view SELECT permission. The additional Meri-owned source projection is:

- `prepared_approvals`: a JSON array of at most 64 proposals for the same
  tenant, actor, conversation and run, ordered by relational proposal id;
- `prepared_approvals_overflow`: true when a 65th proposal exists;
- each entry: relational `proposal_id`, `command_id`, `idempotency_key`,
  `command_sha256`, and a `record` containing exactly the original eight fields
  `proposalId`, `commandId`, `idempotencyKey`, `createdAt`, `expiresAt`,
  `requiredApprover`, `binding`, `scopes`.

Core binds tenant, actor, conversation and run in SQL, checks those four IDs
again in the view's current run binding, and requires one row, a nonoverflowing
bounded array, unique proposal ids and exactly one requested proposal. It
compares the relational fields and all eight stored record fields against the
forwarded proposal. The stored seven-field binding remains the **original**
prepared binding; a later executor attempt does not rewrite it. A missing view,
row or malformed/overflowing projection returns 503. A missing proposal or a
valid but different prepared proposal returns 409. Core does not query the raw
metadata table or request a new raw-table grant.

Approval record verifies before writing its immutable decision. Execution
issuance verifies again on its existing tenant transaction **after** taking
the proposal lock and before reading the decision or issuing a capability.
The proposal parser verifies the command's RFC 8785 hash; the verifier checks
it against the projected relational `command_sha256`. The original Meri
`payload_sha256` is not independently recomputed by Core; no such claim is made.

## Focused source checks and remaining gates

The Core tests include a PostgreSQL-compatible PGlite role with SELECT on the
security-barrier facts view and no SELECT on the private source table. They
exercise tenant, actor, conversation and run isolation; missing, overflowed,
duplicated and malformed projections; original binding and relational mismatch;
and the proposal-locked issuance call. Tests do not prove the deployed role or
the full Meri lifecycle.

Meri must allocate/register and publish its view migration, then the deployment
owner must apply it in the approved order and read back the restricted Core
role's view access and a real prepared proposal after allocation. The current
`run_facts_v1` has an inner join to installed tool-run allocations; the source
flow describes preparation inside an admitted run, but runtime ordering is not
yet proven. Approval remains unavailable until these gates and exact
source/image/config readback pass. No live SQL or deployment was performed.
