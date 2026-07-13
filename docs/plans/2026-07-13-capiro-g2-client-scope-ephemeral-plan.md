# G2 — Client memory scope + ephemeral/working class

**Goal (blueprint §3.5 "Remember for this client or matter" + §5.4 scope
table):** extend the proven Phase-1 memory model with (a) CLIENT-scoped
memory and (b) an EPHEMERAL class with a DB-boundary expiry guarantee.

## Audit-established facts (2026-07-12, G2 kickoff audit)

- `memory_items.client_id` already EXISTS (indexed, no FK); `context_embeddings.client_id`
  exists (FK, SET NULL). `clio_memory` has NO client_id.
- `upsertSectionsForCurrentTenant` already accepts scope `'client'` → maps to
  `visibility='tenant'` + clientId (memory-store.service.ts:279-320). The 1C
  RLS policy admits that shape unchanged.
- `clio_memory` CHECKs: `scope IN ('firm','user_private')` + scope_owner_check
  (migration 20260525103000:82-94). `memory_candidate` CHECKs: scope IN
  ('personal','firm') (20260712020000:32-37).
- NO TTL/expiry primitive exists anywhere in the memory layer. retentionPolicy
  jsonb is unenforced; reviewCadenceDays advisory-only.
- Reader inventory (each needs the expiry filter + client handling):
  search_memory (meri-tools.service.ts:1807), listForCurrentTenant/getByTypeSlug/
  loadGraphInputs (memory-store.service.ts), loadGraphForCtx (meri-tools:1672),
  semanticMemorySearch + loadRelevantMemories + learned-memory list/edit/forget
  (meri.service.ts), Context Compiler adapters (compiler-side exclusion).
- Scope strings today: clio_memory 'firm'|'user_private'; candidate
  'personal'|'firm'; memory_items visibility 'tenant'|'user'.

## Design decisions

1. **Client scope = `visibility='tenant'` + `client_id` set** (the shape the
   store already emits). NO RLS policy change needed for scoping: every tenant
   member may serve every client today (no per-user client ACL exists), so
   client scope is a RELEVANCE boundary (loaded only for that client's
   conversations/drafts), not an access boundary. Recorded honestly: the
   blueprint's restricted/privileged scopes (legal, matter-restricted) remain
   future work requiring a real ACL — do NOT claim client scope is
   DB-enforced access control.
2. **Ephemeral = `expires_at TIMESTAMPTZ`** on clio_memory + memory_items,
   with THREE enforcement layers:
   a. RLS policy predicate `(expires_at IS NULL OR expires_at > now())` on
      memory_items — the DB-boundary guarantee (expired rows unreadable even
      if a reader forgets). Separate migration per the 1A/1C split-migration
      discipline; low-risk (only ever HIDES expired rows).
   b. Reader WHERE filters (defense in depth, clio_memory reads).
   c. Purge: extend the daily refresh-memory-graph job to hard-delete expired
      rows + their context_embeddings (tombstone-free — ephemeral was never
      governed history).
3. **Candidate lifecycle**: scope 'client' added to memory_candidate CHECK +
   `client_id` column; evaluateMemoryCandidate rule: client+admin → PASS,
   client non-admin → WARN pending (mirrors firm — client strategy is
   approved-positions territory, blueprint §4.6.2 "client lead or authorized
   team").
4. **save_memory verb**: scope enum += 'client' (requires the conversation's
   clientId), `ttlDays?: number` → expires_at (ephemeral working memory —
   any scope). confirm/correct/forget work unchanged (id-addressed).
5. **Recall**: clio_memory readers add `OR (scope='client' AND client_id = $conversationClient)`;
   semantic + keyword paths. memory_items readers get the expiry filter.
6. **Context Compiler**: SteeringRow gains `expiresAt`; compiler records
   expired rows as a new `'expired'` exclusion reason (contract widened).
7. **clio_memory gains `client_id`** + write-through projection maps
   scope 'client' → visibility 'tenant' + clientId (stop hard-coding null in
   clioMemoryToItem).

## Migrations
- `A_memory_client_scope_ephemeral` (additive): clio_memory client_id +
  widened scope CHECKs; memory_candidate client_id + widened scope CHECK;
  expires_at on clio_memory + memory_items (+ partial index
  `(tenant_id, expires_at) WHERE expires_at IS NOT NULL`).
- `B_memory_items_expiry_rls` (policy replace): memory_items_isolation gains
  the expiry predicate. Applied in its own deploy window.

## Sequence
1. Migration A + write-path code (candidate/verbs/projection) + reader client
   recall + reader expiry filters + purge job + compiler 'expired' + tests.
2. Land + deploy + verify (rows round-trip, candidate queue shows client scope).
3. Migration B (RLS expiry) + fail-closed spec additions. Land + deploy +
   canary (expired row invisible via RLS with no app filter).

## Verification gates
- Unit: candidate rules for client scope; save->recall round trip filters by
  conversation client; expired rows excluded on every reader; compiler traces
  'expired'.
- Live: seed an ephemeral memory with a past expires_at on capiro-internal
  via sql-exec; confirm recall misses it pre-purge (RLS) and the purge job
  deletes it + its embedding.
