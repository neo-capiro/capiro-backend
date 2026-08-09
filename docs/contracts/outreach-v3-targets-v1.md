# Outreach V3 Target Identity and Selection Contract V1

## Purpose

This contract defines how Outreach V3 discovers, proposes, selects, persists, reauthorizes, and removes campaign targets without treating a conversational response or email address as canonical identity.

## Sources

Supported target locators:

- `directory_member`
- `directory_staff`
- `state_legislator`
- `client_person`
- `engagement_contact`
- `manual`

A locator is a reference. It is not trusted target truth.

## Server-resolved snapshot

`ADD_TARGET_REFS` accepts strict locators. Before the pure Campaign Spec reducer runs, Capiro:

1. resolves each locator from its authoritative source;
2. reauthorizes tenant/client access;
3. normalizes identity and contact fields;
4. records role, jurisdiction, profile and email status;
5. records source version/freshness;
6. computes a canonical snapshot hash.

Only the server-resolved snapshot enters Campaign Spec.

## Identity

Campaign identity is `targetKey`, derived from source and source-owned identity. Email is a delivery attribute, not the primary identity key.

Distinct identities may share an email. They must never be silently merged. A collision is a target-health/preflight problem.

## Recommendations

`search_targets` returns deterministic `recommendationRef` values derived from:

- target key;
- normalized targeting criteria hash;
- explicit client target-source scope, when present.

Recommendations never add targets automatically.

The reasoning gateway may propose `ADD_TARGET_REFS` only when the exact locator appears in a Capiro tool result explicitly referenced by the final response. The resulting command proposal remains pending until the user applies it.

## Manual targets

Manual targets are user-supplied campaign references. They are not automatically written into the shared Directory.

Manual notes are marked user-supplied and are not approved personalization facts.

## Removal and rejection

- `REMOVE_TARGET_REFS` removes selected target keys through the deterministic command engine.
- `REJECT_TARGET_RECOMMENDATION` persists the exact recommendation reference and target key so the same recommendation is excluded for that criteria/client scope.
- Rejection is campaign-local and does not globally suppress the target.

## Restore and freshness

State restore reauthorizes every selected locator before creating a new state version.

Profile and coverage reads compare the persisted selected snapshot with the current source snapshot and return:

- `current`
- `changed`
- `unavailable`

No read silently refreshes Campaign Spec. Updating a snapshot requires an explicit later command path, or remove/re-add in Phase 4.

## Security

- tenant comes from authenticated context;
- client-scoped targets reauthorize the client;
- ethical-wall/inaccessible targets are indistinguishable from missing targets;
- raw private note, meeting-note and email bodies are excluded;
- model-provided tenant/user/source authority is ignored;
- target commands have no generation/send authority.
