# Outreach V3 Campaign State V1

## Status

Revised Outreach Phase 2 contract.

```text
schemaVersion = outreach_campaign_spec_v1
canonical runtime = existing engagement-api
current Outreach v2 = unchanged
OpenAI reasoning = absent
LangGraph = prohibited
external generation/send = absent
```

## Source of truth

The canonical Outreach campaign is the current immutable `OutreachStateVersion` snapshot referenced by `OutreachSession.current_state_version`.

A conversation, future model response, browser-local wizard state, or UI stage is never campaign truth. Future reasoning may inspect the current state and propose strict commands; only the deterministic command engine may create a new canonical version.

## Storage boundary

Phase 2 owns four isolated tables only:

- `outreach_sessions`
- `outreach_state_versions`
- `outreach_events`
- `outreach_command_proposals`

They reference tenant/user/session identity only. They do not require or mutate `OutreachRecord`, draft artifacts, jobs, send intents, deliveries, meeting bots, integration connections, or provider state.

## Session contract

A session:

- belongs to exactly one tenant;
- is private to `created_by_user_id` in Phase 2;
- may be created with **no client**;
- starts at state version `1`;
- is archived rather than deleted;
- retains all state versions and events after archive.

`sessionId` alone never authorizes access.

## Campaign Spec V1

The spec is strict JSON with explicit nulls and no undefined values.

Top-level sections:

```text
goal
sponsor
targeting
delivery
context
strategy
```

No field named `stage`, `wizardStep`, `currentStage`, `reasoning`, `chainOfThought`, or equivalent is part of the contract.

### Goal

```text
goal.goal
goal.objective
goal.topic
goal.desiredOutcome
goal.ask.mode = undecided | explicit | none
goal.ask.text
goal.whyNow
```

An explicit ask requires text. Non-explicit ask modes require `text = null`.

### Sponsor

Sponsor is independent of audience/targets.

```text
undecided
firm
client
multi_client
coalition
internal_team
none
```

Rules:

- `client` requires exactly one unique client reference;
- `multi_client` requires at least two unique client references;
- `coalition` requires a nonblank label and may contain zero or more clients;
- `undecided`, `firm`, `internal_team`, and `none` contain no client refs;
- duplicate identical client refs normalize to one;
- every referenced client is reauthorized server-side at mutation/restore time;
- if any referenced client is unauthorized or ethically walled, the whole command fails.

### Targeting

Phase 2 stores user/model **criteria**, not authoritative target facts.

```text
targeting.criteria
```

Target selection/recommendation reference arrays are reserved in the schema but must remain empty in Phase 2. Their later owning phase defines target identity and authorization.

### Delivery

Pattern:

```text
undecided
personalized_separate
uniform_separate
shared_thread
```

Personalization:

```text
undecided
high
light
none
```

`shared_thread + high` is rejected explicitly. It is not silently normalized.

### Context

Context-reference arrays are reserved but empty in Phase 2. No governed context is commingled or accepted before its owning phase.

### Strategy

```text
strategy.campaignAngle
strategy.tone
strategy.length = undecided | short | medium | long | custom
strategy.customLengthInstruction
```

Custom length requires a nonblank instruction; other length modes require it to be null.

## Bounds and text rules

The spec is bounded to 1 MiB canonical UTF-8 bytes. Individual fields and arrays have smaller frozen limits in `outreach-campaign-spec.v1.ts`.

Text normalization:

- CRLF/CR becomes LF;
- surrounding whitespace is trimmed;
- empty normalized nullable text becomes null;
- disallowed control characters are rejected;
- Unicode text is preserved.

## Canonicalization and hashing

Canonical JSON:

- recursively sorts object keys with locale-independent lexical ordering;
- keeps order-sensitive arrays in order;
- deduplicates and stable-sorts set-like arrays;
- contains no undefined values;
- contains explicit nulls.

`spec_hash = sha256(canonical UTF-8 JSON)`.

No clock, random identifier, environment locale, provider response, or model output participates in canonical state hashing.

## Version invariants

- version numbers begin at `1`;
- `(session_id, version)` is unique;
- state-version rows are DB-enforced append-only;
- a real command batch creates at most one new version;
- a deterministic no-op creates no new version;
- restore **always creates a new version**, even when restored content hashes identically to the current state;
- old state rows are never rewritten or made current by pointer rewind.

## Concurrency

Every mutation supplies `expectedStateVersion`.

The service locks the owner session before idempotency lookup and version comparison. A stale writer receives `OUTREACH_STATE_CONFLICT`; the server does not auto-retry or merge it.

## Privacy / data classification

Campaign planning state may contain sensitive government-affairs strategy. Therefore:

- full specs live in immutable state versions, not operational logs;
- session lists return bounded metadata rather than duplicate spec bodies;
- event records carry identifiers, command types, hashes, versions and bounded safe metadata;
- proposal commands are tenant/owner scoped;
- hidden model reasoning is never stored;
- client names, goal/ask text, campaign angle, recipient data, target names/emails and context bodies must not be emitted as observability dimensions.

## Recovery

Recovery is version-based. Operators/users restore an earlier version through the strict `RESTORE_STATE_VERSION` command, which revalidates references and creates a new snapshot. See `docs/runbooks/outreach-v3-state-recovery.md`.
