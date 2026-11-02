# Institutional Memory — Implementation Status

## Private Settings drafts (2026-10-29, source API)

`20281029060000_settings_memory_drafts` adds private staging through
`/memory/settings/:type/:slug/drafts`. Drafts reuse current Core membership,
memory authorization, client walls and immutable ownership periods. They keep an
exact active-source digest and a separate draft revision. Saves use a caller
request identity with an immutable content-free receipt in the same transaction;
retries return the original receipt, and stale concurrent writes are refused.
Receipt state describes that historical operation, not current publication.

The draft table is not an ingestion, embedding, recall or review source. Saving
and discarding leave active memory unchanged. The existing daily worker erases
unsubmitted draft sections 30 days after creation; save does not extend expiry.
Expired content is suppressed before cleanup. Direct holds and held source
lineage prevent erasure; the draft identity and response receipts survive so
late writes cannot revive discarded or expired content. Source hold selection
and destructive locking reuse the existing memory retention helpers.

The source API and migration are tested with an ordinary PostgreSQL role.
Frontend editor/recovery, atomic submission into the existing candidate or
personal version owner, explicit client-purge composition and external restore
reconciliation remain open. The API reports `publicationAvailable: false`.
This is not deployment or full Settings feature completion.

## Owner policy (2026-10-29, source implementation)

`20281029050000_memory_owner_retention` binds canonical items, Clio sources and
candidates to an explicit personal, client or firm ownership period. Core's
membership removal and client archive transactions close the relevant period,
with deadlines of 30 and 90 days respectively. Firm ownership does not depend
on the author's membership. Reactivation creates a new period and cannot reopen
old content. RLS blocks closed periods and their vector/graph projections;
trusted ingestion and embedding writers check the same current ownership.

The existing daily `refresh-memory-graph` worker invokes
`purgeMemoryOwnerRetentionInTx` for its selected tenants. It preserves legal-held
content and retained lineage, reports remaining Core rows, and records immutable
content-free tombstones that refuse late INSERT retries. A failed transaction
rolls back its deletion effects and outcomes together. The worker's counts do
not claim completion of external Meri cleanup.

Legacy rows are attributed using explicit ownership columns, with typed source
bindings checked for agreement. Missing, inactive or contradictory ownership is
restricted; no offboarding date is guessed from an update timestamp or citation.
Attribution does not approve or activate governed content. Existing stable file
keys remain subject to conflict refusal when a closed version still occupies one.

Validation covers the real forward migration, ordinary-role writes and RLS,
offboarding/write races, reactivation, deadline cleanup, hold release, late replay,
and embedding results arriving after closure. Whole-backup recovery must still
reconcile the external authoritative retention record. Settings draft/receipt UI,
restricted-record resolution, and external deletion orchestration remain open.
No application build or deployment was performed.

## Retention correction (2026-10-29, source checks)

Client purge and scheduled expiry share `memory-retention-selection.ts`. The
cleanup transaction waits for hold writers before selecting records, preserves
held candidates and their revision/source dependencies, and retains those sources
in `clio_memory`. Client purge clears both client wall grants and memory permission
grants. Its response distinguishes retained candidates from retained items.

Recall and embedding eligibility use the current database clock, including after
a row-lock wait, so a transaction's start time cannot admit newly expired content.
The pending-review fixture now asserts the existing rule that disabling lifecycle
enforcement cannot expose unapproved governed content.

Validation: 122 focused tests pass, including 52 PostgreSQL tests for expiry,
holds, revision FKs, cross-tenant selection, writer contention and rollback. Seven
new retention cases run under an ordinary database role. Focused TypeScript and
diff checks pass. No application build, deployment or live acceptance was run.
The approved owner/offboarding deadlines, Settings drafts, privacy request
orchestration and cross-system restore suppression remain separate open work.

The deployment notes below are historical, not verification of this change.

> Status corrected 2026-07-05. The previous version of this file claimed the
> memory layer was "not merged / not deployed (per Neo)". That was stale and
> actively misleading: the layer was integrated to `origin/main` in commit
> **bf5330b** ("feat(memory): integrate memory layer into app") and is **live in
> prod** — the API entrypoint runs `prisma migrate deploy` on every deploy
> (`apps/api/scripts/entrypoint.sh`, `migrate` case), so the
> `20260625130000_institutional_memory` migration (memory_items + memory_edges +
> RLS) is applied wherever the API has shipped.

## What is live
- `memory_items` / `memory_edges` tables with tenant-only RLS (migration
  `20260625130000_institutional_memory`).
- Store / render / parse / graph / governance / interview services under
  `apps/api/src/memory/` + the `/memory/*` controller (catalog, items, markdown,
  graph, interview, `POST /memory/backfill`).
- Backfill/ingestion (`MemoryIngestService.backfillCurrentTenant`): Phase A
  clients, B ClioMemory projection, C meetings (+ tenant-readable debriefs as a
  never-embedded engine section), D email threads, E Meri sessions, F embeddings.
- FK graph edges: client→bill/issue/person/meeting, meeting→attendee.

## Backing store note (do not "fix" this)
Meri's live chat + learned-facts store is the `clio_*` tables (`clio_messages`,
`clio_conversations`, `clio_memory`) — "Clio" is the retired brand; the tables
were never renamed. Referencing `clio_*` from Meri/memory code is CORRECT. The
older `chat_message` table is genuinely retired (dropped by migration
`20260627130000`); nothing should read it.

## Hardening (2026-07-05)
Tracked by `~/.hermes/plans/2026-07-05-institutional-memory-hardening-plan.md`.
Shipped in this branch (code + migrations; DB apply is gated on a prod window):
- **Phase 1** — Meri-session ingestion repointed `chat_message`→`clio_messages`
  (was broken in prod); `POST /memory/backfill` now returns `{embedded, failed,
  failures}`; **clio_memory RLS** (migration `20260705120100_clio_memory_rls`)
  with every reader/writer confirmed scoped (incl. the two standalone scripts,
  now bypass-wrapped); **firm-dup partial unique index** + dedup (migration
  `20260705120000_clio_memory_firm_dedup_unique`) + concurrency-safe `saveMemory`
  upsert (P2002 re-find).
- **Phase 2** — write-through: every clio_memory mutation (save / auto-learn /
  update / delete) now projects to `memory_items` + embedding in the same
  request (fire-and-forget, non-fatal); `refresh-memory-graph` wired as a daily
  scheduled job (entrypoint + `INGESTION_JOBS`).

## Remaining (see the hardening plan)
- Phase 3 (private-item fail-closed hardening), Phase 4 (firm-memory governance
  gate) — both have an open 3a/3b · 4a/4b design choice.
- Phase 5 (graph coverage: office edges first) — additive.
- Prod cutover of the Phase 1/2 migrations: gated on Neo's window + a clone test
  + the post-deploy RLS canary (per the plan's guardrails).
