# Private Office draft custody

Source slice, 29 October 2026. The user selected free self-hosted Collabora CODE
for development/testing, private Save, a separate explicit Publish, and initial
exclusive editing. This module is the Core private-byte owner. It is not a WOPI
server and does not activate live Office editing.

## Ownership and calls

`OfficeDraftController` is registered in MeriModule at `/api/clio/office-drafts`.
Every method requires existing verified tool-service identity and native current
application authority. Core's current membership, owned active conversation and
client-wall owners authorize the operation inside the same transaction. The
existing `withTenantUser` owner sets the tenant and actor RLS context. Source
identity columns cannot be updated by the ordinary application role.

The trusted runtime artifact owner must inspect the exact base, enforce its
current scopes and retention, and supply the immutable source descriptor on
`open`. It must repeat current artifact authority/retention on every later
crossing. These endpoints are not direct browser APIs; a browser cannot certify
its own source or publication result.

| POST suffix | Responsibility |
| --- | --- |
| `open` | Create or read back the same exact draft/source identity |
| `read` | Recover private bytes and exact sequence/hash |
| `editor` | Inspect/acquire/refresh/release/explicit takeover of one editor binding |
| `editor/read` | Private read requiring the current editor ID and epoch |
| `lock` | Current editor proof plus atomic get/lock/refresh/unlock/relock; 30-minute file-lock expiry |
| `save` | Current editor proof, matching file lock and sequence CAS; all Save kinds remain private |
| `publish/begin` | Freeze one exact sequence/hash and retain its publication intent |
| `publish/settle` | Record only that intent's authoritative result |
| `discard` | Remove private bytes and close the identity unless publication is pending/unknown |

Inputs are closed objects. Draft IDs and base version IDs are UUIDs. Save accepts
canonical base64 for at most 20 MiB, with a verified SHA-256. The exact save route
has a bounded 28,000,000-byte JSON parser; other routes retain their existing
limits. Responses are private/no-store. No save triggers structural rendering or
publication; an invalid Office document can still be retained for recovery.

Save returns only after database commit. Identical bytes reuse the saved sequence.
Competing writes at one sequence yield one accepted successor. Lock and sequence
checks are in the same database transaction. These are exclusive WOPI locks for
one private draft. The editor-admission migration `20281029070000` adds a separate
current editor ID, increasing epoch and ten-minute expiry to that same row.
All acquisition, takeover and Save decisions use its existing transaction lock
and the actual database clock, so different control instances choose one editor.
Acquire/takeover accepts an expected epoch, increments it, and clears the old
WOPI lock. Replaying its exact acknowledgement does not extend expiry. Refresh
preserves epoch/lock; release clears the binding and lock without losing bytes.
Expired editors cannot refresh themselves back to life. Reusing an editor ID
still gets a new epoch; stale tokens cannot revive after release/reopen.

The control-only `lock` and `save` input now requires `editorId` and
`editorEpoch`; no legacy unfenced write fallback remains. `editor/read` checks
the same proof atomically. The authenticated `read` route remains the UI's
recovery path when an editor process/session has ended. This private receiving
change must ship with its matching runtime bridge/token source. WOPI tokens
must carry the exact editor proof, expire no later than the current admission
and native session, and be checked against Core on every call. No bearer is
stored in the draft row, and no lease alone grants current artifact authority.
Actual multi-frame CODE behavior remains unqualified.

## Publication and retention

The existing runtime artifact publisher and its intent journal remain the sole
immutable version and stale-parent owners. The draft row stores only the editor
state and `office:<draftId>:<sequence>` identity. A repeated pending/unknown begin
returns `dispatch:false`. Current bytes cannot change until a definite settlement
arrives. Unknown is never cleared by elapsed time. Published settlement requires a
version ID; this receiver does not create that version or independently certify
its existence. Only the trusted publisher may call settlement after exact readback.

The seven-day private-byte expiry is enforced on reads/writes. The existing
internal-service identity protects `/api/internal/office-draft-retention/expire`:
an exact tenant/actor/chat batch deletes up to 100 expired rows, returns counts
only, and works after the member departs. The retention coordinator must retain
policy and hold checks before invoking it. Conversation, tenant and actor deletion
cascade through the existing parent rows. Discard removes bytes immediately and
retains a closed identity until expiry, preventing an unexpired WOPI token from
being revived by reuse of the same draft ID. Runtime suppression/access-loss purge
coordination and scheduled inventory integration remain required before activation.

The same internal-service controller now provides `POST /read` and `POST /retire`
under `/api/internal/office-draft-retention`. Both take exactly
`{tenantId, subject: {kind: "conversation" | "artifact", id}}` and echo that scope
under `meri.office-draft-retention.v1`. The read returns only `drafts`, `active`
and `bytes` counts. Retirement clears private bytes, hash, editor/lock and
publication claim from at most 100 rows, returning `retired` and `remaining`.
An artifact scope includes all actors' private drafts in that tenant. System
scope is limited by explicit tenant and subject SQL predicates; a browser/native
user credential cannot authorize these operations. No schema or grant changes.

The trusted Meri retention coordinator must hold its canonical subject exclusion,
apply policy/holds, drain in-flight work and repeat bounded batches plus a fresh
inventory read before claiming erasure. `remaining: true` includes skipped locked
rows. This endpoint alone cannot prevent a concurrent new draft from appearing.
It does not decide suppression, access loss, or holds, and native session expiry
alone is not authority to erase a recoverable draft. A closed draft keeps existing
source metadata and its identity until normal expiry; immutable published bytes
are owned elsewhere. Restore/startup verification must read current counts rather
than trust an old retirement response. Runtime composition remains required.

Chat Trash is connected directly to Core's metadata owner: `manageConversation`
uses the existing actor-scoped transaction and retires that chat's private drafts
before committing its status and immutable management receipt. The conversation
row lock orders this against every editor write. A failed Trash rolls cleanup
back; a late Save rechecks the now-inactive chat and is refused. Restore does not
revive closed drafts, while Archive preserves them. Replaying current Trash also
cleans restored draft copies; an old Trash replay against an active restored chat
does not erase newly created drafts. Artifact suppression, membership/client
access-loss cleanup and expiry scheduling still require their owner integration.

Five additional ordinary-role PostgreSQL cases cover closed-token reuse,
all-writer artifact selection and cross-tenant isolation, 100-row batches,
locked-writer incompleteness, departure, restored bytes and eventual expiry.
The fixture uses the existing transaction-local system bypass setting and proves
it does not leak into a subsequent actor-scoped read. Earlier fixture databases
are preserved; the retirement cases require a fresh fixture with that helper.

## Verification and remaining work

57 focused source tests pass, including 17 real PostgreSQL tests under an
ordinary NOBYPASSRLS role: connection restart/readback, conflicting writers,
locks/expiry, owner and tenant privacy, immutable source columns, revocation,
unknown publication, stale-base result preservation, and physical expiry cleanup.
The additional database cases prove concurrent editor admission, ACK replay,
takeover, release/reopen, expired/stale proofs, epoch exhaustion, current access,
and a Save queued behind takeover refusing before changing bytes.
The HTTP tests exercise the real Nest/Express size boundary; native identity is
synthetic. Focused source TypeScript, Prisma validation and 27 closure/pin tests
pass. Schema validation retains the repository's existing SetNull warning.

This is not end-to-end Office completion. Runtime native-byte publication and
the Core client have merged source slices, but the WOPI HTTP adapter, versioned
Office browser receiver, current suppression bridge, iframe/recovery controls,
actual CODE service and representative Office fidelity corpus remain unqualified.
No application/image build, deployment or provider call was performed.
## WOPI opaque lock compatibility

The lock boundary preserves printable ASCII spaces, including opaque JSON-like
lock IDs, up to 1024 characters. Controls, non-ASCII and overflow remain refused.
The same validator governs Save, Lock, Refresh, Unlock and atomic relock; no
schema or migration changes are needed. A boundary case and an ordinary-role
PostgreSQL roundtrip cover the extended lock through Save and relock. The two
affected suites pass 34 cases, including 18 real PostgreSQL cases. This source
change pairs with the runtime WOPI adapter's matching wire validator.

Reference: [WOPI UnlockAndRelock](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/files/unlockandrelock).
