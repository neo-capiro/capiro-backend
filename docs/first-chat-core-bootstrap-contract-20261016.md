# Core first-chat conversation bootstrap (source contract)

Core owns the native `ClioConversation` allocation. The route is `POST
/api/clio/conversations/bootstrap` under the existing Clerk bearer, tenant
context, and `standard_user` role guard. The frontend sends exactly:

```json
{"schemaVersion":1,"requestId":"<UUID stable for one New Chat intent>","clientId":"<UUID>"}
```

Neither tenant, actor, nor conversation ID is accepted from the browser. A
successful create or replay returns HTTP 200 with the same field values:

```json
{"schemaVersion":1,"requestId":"<UUID>","conversationId":"<Core UUID>","tenantId":"<Core tenant UUID>","actorId":"<Core user UUID>","clientId":"<UUID>"}
```

Core stores `(tenantId, actorId, requestId) -> (clientId,
conversationId)` in `clio_conversation_bootstrap_receipts`. This identity is
unique. The first conversation and receipt commit in one transaction. A
concurrent duplicate loses the unique-key race, rolls back its attempted
conversation, and reads the winner in a fresh transaction. UUIDs are returned
in canonical lowercase form. Legacy `POST /api/clio/conversations` remains a
separate non-idempotent operation.

For every successful replay, Core checks that the exact conversation still
belongs to the authenticated tenant and actor, is active and unarchived, is
still assigned to the original client, and that the client is currently active
within that tenant and visible to the actor under Core's client memory wall.
This matches the existing `/context` client predicate. A
request ID reused with a different client returns 409. An archived, moved, or
deleted conversation also returns 409; a deleted conversation leaves a poisoned
receipt and is never replaced under the same request ID. A no-longer-visible
client returns 404. Malformed body fields return 400. The receipt has no
expiry or currentness revision because Core cannot guarantee either across a
later mutation.

The frontend may cache the `requestId` only for the current New Chat intent
and repeat the exact request after timeout. It must not treat the receipt as
Meri admission authority. Meri verifies native Core
`POST /api/clio/application-authority/identity` and
`POST /api/clio/application-authority/context` for the returned conversation
ID before admitting and binding its own original run at writer fence 1. The
context route rejects a nonexistent, foreign, archived, or wrong-client row.
Its canonical identity hash join remains Meri-owned. Core does not create a
Meri run in this operation.

This source change uses the separately reserved Core migration
`20281016020000_clio_conversation_bootstrap_receipts`. The migration has not
been executed; native database and full app qualification remain pending.
