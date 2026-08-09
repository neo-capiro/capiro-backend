# Outreach V3 Governed Context Contract V1

Status: Phase 5 implementation contract. Verification is intentionally deferred to the combined Phase 4-6 acceptance pass.

## Purpose

Outreach context is canonical campaign state, not chat transcript state. A context item becomes usable by later drafting only after its exact source, class, scope, authorization, sensitivity, verification status, and source snapshot have been resolved by Capiro and the user explicitly applies an `ACCEPT_CONTEXT_REFS` proposal/command.

## Context classes

- `required_policy` — verified factual/policy material that must govern later drafting.
- `writing_guidance` — authorized instructions/style guidance. Never factual evidence.
- `campaign_fact` — campaign-wide factual material.
- `target_specific` — material usable only for one exact selected target.
- `group_safe` — normal-sensitivity material explicitly approved for one group scope.

## Scopes

- `campaign`
- `target:{targetKey}`
- `group:{groupRef}`

Target-specific material must use target scope and reference a currently selected target. Group-safe material must use group scope.

## Source locators

- governed `memory_item`
- `capiro_record` (`client`, `meeting`, `engagement_task`)
- governed `document`
- `government_record`
- `target_profile_fact`
- `manual`

Client-bearing locators use exact client scope. `clientId=null` is not a wildcard: it means the underlying source itself must be tenant-neutral.

## Canonical resolved snapshot

A resolved context reference records:

- content-addressed `contextKey`;
- exact locator;
- context class and scope;
- bounded title/summary;
- client scope;
- verification class;
- sensitivity;
- `instructionsAllowed`;
- `usableAsEvidence`;
- `usableAsWritingGuidance`;
- source system/version/last-verified timestamp;
- deterministic snapshot hash.

The source is reauthorized before acceptance and again on state restore. Context review re-resolves the source and reports `current`, `changed`, or `unavailable` without silently mutating Campaign Spec.

## Sponsor isolation

Client-specific accepted context is valid only when the campaign has exactly one explicit `client` sponsor and every client-specific context reference belongs to that same client.

Firm, internal, no-sponsor, coalition, and multi-client campaigns remain client-neutral in Phase 5. Per-client generation packets are a later-phase concern.

Changing sponsor scope in a way that would strand client-specific accepted context is blocked transactionally.

## Memory rules

Memory lookup preserves:

- tenant scope;
- owner-private visibility;
- governed lifecycle suppression;
- expiration;
- ethical walls;
- `instructions_allowed` separation;
- verification/sensitivity metadata.

When no client scope is authorized, `search_memory` searches tenant-neutral memory only (`client_id IS NULL`).

## Document rules

Document context:

- resolves exact tenant/client scope;
- accepts only ready/legacy-ready, non-superseded attachments;
- never returns raw S3 credentials or unrestricted file bytes;
- carries evidence-readiness information;
- preserves meeting privacy: an attachment linked to a meeting is available only when that meeting is shared or owned by the requesting user.

## Government research

`research_government` searches Capiro’s source-backed public datasets and returns exact references. Results remain inside the authenticated tenant capability envelope even though the underlying government records are global.

## Model boundary

The reasoning model may discover context and propose `ACCEPT_CONTEXT_REFS` or `EXCLUDE_CONTEXT_REFS` only when grounded in exact referenced Capiro tool results or current Campaign Spec state.

It cannot:

- directly mutate state;
- convert writing guidance into evidence;
- widen target/group/client scope;
- access private message/note bodies;
- generate drafts;
- approve drafts;
- preflight;
- send.

## Readiness

Phase 5 considers context reviewed when accepted context exists. Evidence readiness additionally requires factual context to be usable as evidence, subject to the explicit user-supplied target-specific exception encoded in the readiness contract.

Generation, drafts, and preflight remain unavailable in Phase 5.
