# Saved Workspace newsletter revision staging

This additive source slice extends the canonical Workspace VersionsService and
existing OutreachV3 command engine. Required base is prospect resources PR2400
`6c26ac2dad3756a61b6733329dea7ce3c9138ece`, preserving sender PR2393 and its reply/
attachment ancestry. It creates no replacement document, campaign, service or
receipt store. Nothing is deployed or database-qualified.

## Select one exact saved revision

`GET /workspace-api/drafts/:draftId/versions/:versionId/outreach-revision` uses
Workspace tenant authentication and requires current active Core tenant membership,
the addressed draft's current owner/active collaborator read/export rights, and
current canonical client authority when a `config.clientId` UUID is present.
The helper resolves the Clerk subject to the actual Core user UUID; the Core
staging caller must match both identities. No administrator bypass applies.

The response contains `draftId`, `versionId`, the original `authorId`, `authorKind`,
`savedAt`, the selected saved `snapshot`, its `snapshotHash`, `clientId`, and a
bounded `contentSkeleton` projection. `hashFormat` is
`workspace-snapshot-canonical-json-v1`: SHA-256 of the UTF-8 canonical JSON with
object keys sorted by JavaScript ordinal string order and array order preserved.
Hashes cover the complete saved snapshot, including config, document bodies and
ask. The live working-copy text is never substituted.

The existing Workspace plaintext projection (document blocks, then saved primary
config section content) supplies the literal skeleton. It keeps saved document
order and does not invent content or slots. Empty/unrenderable content, snapshots
above 1,000,000 serialized characters, body above 8,000 characters, title above
400 characters, or template slot delimiters `{{`/`}}` are unavailable. Nothing is
truncated. Rich formatting, attachments and other source metadata are not promoted
into a message artifact; the exact snapshot remains owned by WsDocVersion.

This bounded distribution slice refuses prospect drafts and every immutable
`ws_source_action` origin, including LegiWatch research, editorial, preparation
and unknown future source types. Those published source contracts require their
own explicit distribution authorization. The immutable origin read uses the
existing SELECT permission and does not request a forbidden UPDATE privilege.
Canonical source creation commits each receipt with a new draft, never attaches
one to an existing draft, and the existing trigger forbids changing/deleting it.

Canonical `config.clientId` is declarative context, never an authorization grant.
The saved/current UUID declarations must match, and the current same-tenant,
nonarchived client and actual ethical-wall grant are checked and locked. Legacy
saved/current client display text, `clientAssociated`, `clientPersons`, or the
current draft's `client` display field without that canonical UUID fail closed.
Free-text matching never infers a client. Selection does not enable a source that
cannot satisfy this bounded contract.

## Stage into an existing selected session

`POST /api/engagement/outreach-v3/sessions/:sessionId/newsletter-staging` uses the
existing Outreach state flag, tenant authentication and standard-user role floor.
Input is a strict object; caller-supplied content, commands and actor/tenant fields
are rejected:

```json
{
  "requestId": "<stable request UUID>",
  "draftId": "<canonical draft UUID>",
  "versionId": "<exact saved WsDocVersion UUID>",
  "snapshotHash": "<64 lowercase SHA-256 hex characters>",
  "expectedStateVersion": 7
}
```

The existing session must belong to the authenticated Core actor in the current
tenant. No session is created. Client-associated content requires the current
session's single-client sponsor to equal the exact saved/current canonical client;
firm content requires an explicit firm sponsor. Multi-client, coalition, internal,
undecided and mismatched sponsor scopes are unavailable in this first slice.

One tenant/user transaction locks the session, active tenant/member/user, current
draft/collaborator, saved version, and client/wall grant. Workspace's exported owner
seam performs the same checks for both source selection and Core staging. Core
retains its canonical client authorization and current Campaign Spec hash check.
The existing command engine applies exactly one user-authored
`SET_CONTENT_SKELETON` command with `expectedStateVersion`, preserves its state CAS,
state-version/event audit, proposal supersession, and normalized command hashing.
It creates no target, sender, evidence ref, attachment, sample, draft artifact,
generation job or send intent. No model/provider/upload/send call occurs.

## Durable receipt and retries

The existing `command_batch_result` event is the sole staging receipt. Its existing
unique session+batch UUID key binds `requestId`; `safe_metadata_jsonb` adds
`savedRevisionStaging` with a hash of the normalized tenant/actor/session/request/
selected revision/hash/expected version input, original author/time, exact snapshot
hash, client UUID and normalized command hash. State mutation and receipt commit
atomically. Response preserves the normal command result and adds `receiptId` and
`staged` provenance. A skeleton no-op still commits an attributable receipt.

Exact retries recheck current source/member/destination/client authority before
returning the same receipt with `replayed:true`; they never reapply content.
Changed input, a reused ordinary command ID, changed saved bytes, or a malformed
prior staging provenance cannot be upgraded into another receipt. Changed request
identity with a stale expected state version conflicts. UUID case is normalized;
request IDs share the existing command namespace deliberately.

Authorized archival receipt recovery is supported, but a new archived/completed
session mutation is refused by the existing engine. Deleted source versions/drafts
or revoked membership/collaboration/client grants make retries unavailable. A
later edit or restore of the campaign does not restage the old version: recovery
returns its original applied version/hash. Recovery also requires the current
campaign sponsor to remain compatible.

Staging copies a reviewed plaintext projection into the caller-owned campaign
state. A later source revocation does not retroactively erase already committed
campaign history. No new send/generation activation or automatic withdrawal is
claimed; subsequent actions retain their existing independent controls.

## Integration gate

Workspace migration source `20281012040000_saved_version_immutability` rejects
changes to an existing WsDocVersion. No existing version update path was found;
list/save/restore continue using their existing owners. Existing deletion/cascade
semantics remain. There is no Core schema migration for this slice.

Core reads Workspace-owned tables through the shared owner seam in the same shared
database transaction; it adds no ws_* ORM models and does not write those tables.
A coordinated shared/Core/Workspace source release, the reviewed Workspace
migration, and qualification of exact database-role permissions are prerequisites.
No grants, credentials, network rules, RLS policies, database or migration execution
were performed. Official pinned Prisma WASM/no-engine generation and synthetic
checks establish source typing only. Native PostgreSQL/RLS/MVCC/lock qualification
and deployment preparation remain with dot.
