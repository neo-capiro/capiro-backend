# Institutional Memory — Implementation Status

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
