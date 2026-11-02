# Atomic manual prospect saves

The Workspace draft owner now saves manual prospect sections and their immutable `WsDocVersion` in one transaction. Ordinary and prospect saves share `atomic-draft-save.ts`; the ordinary entry point remains compatible. The prospect facade permits title and section edits only, preserves other configuration/provenance, and refuses copied briefs, whose existing copy owner remains responsible for edits.

`GET /drafts/:id/prospect-state?prospectId=…` returns the current bounded snapshot hash after canonical prospect access checks. `POST /drafts/:id/prospect-save` requires that hash, the original prospect ID and a request UUID. The version ID is that request UUID. Exact retries return the original receipt after current authorization; changed requests or stale states conflict. Content and history roll back together. Legacy direct prospect PATCH writes return `WORKSPACE_PROSPECT_ATOMIC_SAVE_REQUIRED`; ship the matching frontend contract with this change.

Archived prospect history remains readable to authorized actors; mutation follows the existing prospect owner, including current membership, feature eligibility, conversion/client access and collaborator permissions. A client identifier cannot substitute for the immutable prospect origin. No schema migration or separate receipt ledger is introduced.

Validation: seven native PostgreSQL/HTTP cases cover concurrent duplicate saves, competing revisions, rollback, replay, revoked membership, archived history, foreign scope, unchanged ordinary saves and legacy PATCH refusal. The test uses the actual Workspace schema plus an explicit synthetic Core identity fixture. It does not qualify production migrations, grants, RLS, vector/search or deployment. Full Core schema setup on this Windows PostgreSQL installation remains unavailable because the vector extension is absent.

The disposable PostgreSQL schema composer also joins the complementary Core/Workspace `WsShareLink` relations only when stored fields and indexes are identical. Other duplicate declarations and mismatched fields remain errors (25 fixture-helper tests).

This is the manual-save prerequisite for B6. Generation and publication remain separate work; this change does not enable them or any transfer action.

## Published proposal templates

Prospect creation accepts the existing explicit Blueprint pin: blueprint ID, version ID, version number and definition hash. The shared Template Studio resolver permits adoption only from a currently published version visible to the tenant. The bounded, hash-verified definition seeds empty sections, with ordinal labels and retained original section IDs. Template instructions are never inserted as generated proposal content. Blank proposals explicitly store their empty Body section.

The existing prospect creation receipt includes the optional canonical pin. Requests without a pin retain their original hash encoding. Exact recovery returns the originally created draft even if its template has subsequently retired; changing the pin under the same request conflicts, and new adoption of a retired version is refused. Atomic saves retain the adopted template provenance in the immutable document version. No new schema, ledger, generation owner or publication owner is added.

Three additional PostgreSQL cases cover concurrent template creation, exact recovery after retirement, changed-pin refusal, foreign/unpublished/corrupt templates, provenance through atomic save, and legacy blank creation. Together with the existing save suite, ten PostgreSQL/HTTP cases pass. Blueprint pin and prospect-authority compatibility checks bring the focused backend total to 44; focused no-emit compilation also passes. The fixture and deployment limitations above still apply.
