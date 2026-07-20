# Decision Record — Client Memory Ethical Walls (Master Plan Phase 1)

**Date:** 2026-07-19
**Status:** DECIDED (engineering recommendation implemented dev-side) — **prod application awaits Neo's explicit go**, per the standing scheduled-window discipline.
**Source plan:** `Institutional Memory & Knowledge Graph — Master Plan` (Obsidian, 2026-07-19), Phase 1. Continues the deferred D6 of `2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md` ("full matter/client access-control tier — defer").
**Branch:** `dev/memory-ethical-walls` (stacked on `dev/memory-projection-recall-floor`).

---

## 1. The decision

**Ethical walls, opt-in per client** — over the status-quo alternative (client scope stays a relevance-only boundary).

| Considered | Verdict | Why |
|---|---|---|
| A. Relevance-only (status quo) | Rejected | The master plan's audit ranked client confidentiality the #1 gap for the lobbying/gov-affairs domain: firms carry adverse/competing clients, and "any tenant user in the client's conversation recalls that client's memory" is not a defensible confidentiality story. The G2 migration itself documents the limitation. |
| B. Wall everything by default (every client restricted until staffed) | Rejected | Breaks every existing tenant instantly (all client memory vanishes until rosters are built); contradicts how ethical screens work in practice — screens are exceptional and explicit, not the default posture of every matter. |
| **C. Opt-in walls (chosen)** | **Adopted** | Matches domain practice (walls erected per conflict), is a provable no-op at deploy time (flag default-false; dev has **zero** `scope='client'` clio rows — measured 2026-07-19), and gives a conflicted firm a real, auditable screen the day it needs one. |

**Semantics chosen (and why):**
- `Client.memory_wall` boolean (default false) + `client_memory_access` per-user grant rows. Wall + roster are set atomically via `PUT /clients/:id/memory-access` (user_admin), audit-logged with full before/after.
- **Admins are NOT exempt.** A real ethical screen binds seniors; a user_admin who needs access must self-grant, and the self-grant is visible in the audit trail. (Deliberate: the alternative — admin exemption — makes the wall decorative exactly for the people most likely to be conflicted.)
- **Fail-closed everywhere:** unknown user ⇒ denied; client id that doesn't resolve ⇒ denied; walled client with zero grants ⇒ invisible to everyone; recall paths degrade the client arm to absent rather than erroring (a chat about client X by a screened user simply recalls no client-X memory), while the *explicit* per-client surfaces (client subgraph route) 403 loudly so the UI can say "walled" instead of looking broken.
- Writes are NOT wall-gated (WITH CHECK unchanged): memory writes remain governed by the candidate approval flow; the wall's threat model is unauthorized *recall*.

## 2. What the wall covers in this increment (and what it does not)

Covered (every memory read surface): Meri recall (clio keyword + clio semantic + projection), `search_memory` tool, Meri graph tools (`query_knowledge_graph`/`find_path_to`), `/memory/items|review-due|markdown|sections|export`, `/memory/graph*` (incl. FK backbone: bills/people/meetings/offices rooted at a walled client, and walled meetings' attendee edges), and the candidate review queue (a proposal's payload is itself confidential).

**Explicit non-goals of Phase 1** (documented boundary, future product decision): client pages/dashboards, documents, conversations history, engagement/outreach surfaces. The wall governs the MEMORY layer per the master plan; walling the whole client surface is a separate track. Meri's non-memory context (e.g. client roster listing names) is unchanged.

## 3. Enforcement layers — and the RLS-bypass finding that reordered them

The master plan assumed "add client-scoped RLS" = DB-enforced. **Dev probing (2026-07-19, ECS one-off `hermes-memkg-rlsproof`) falsified the premise:** `SET ROLE capiro_app` with no GUCs read **857/857 clio_memory and 7,680/7,680 memory_items rows across all tenants** — ENABLE+FORCE RLS notwithstanding (`rolbypassrls=f`; cause: `capiro_app` is a member of table-owner `capiro_master`, consistent with `prisma.service.ts:63`'s incident note). Therefore:

1. **Application layer = the binding enforcement today.** `memory-wall.helpers.ts` (`fetchDeniedClientIds` / `clientMemoryAllowed` / `wallExclusionSql`) applied at every read surface; static-scan spec `memory-wall-fail-closed.spec.ts` fails CI if a surface drops its wall.
2. **RLS layer = forward-ready, shipped dark.** Migration `20260719221000_memory_wall_rls` replaces the three policies with wall-aware ones (keyed on `current_user_id()` + `client_memory_access`), a provable no-op while no client is walled, and dormant for the app role until role hardening lands.
3. **Role hardening = the unlock** (separate remediation, Neo-gated — auth-adjacent): audit per-table GRANTs to `capiro_app`, revoke its `capiro_master` membership, clone-rehearse, behavioral re-probe. Once landed, criterion "cross-client recall fails closed **DB-enforced**" flips from app-enforced to DB-enforced with zero further app changes.

## 4. Rollout & rollback

- **Dev:** merge → image build (CI) → manual `scripts/deploy-dev.sh` (runs migrate task). At apply: 0 walled clients ⇒ no behavior change. Verify with the fail-closed E2E: wall a test client, confirm non-granted recall/graph/items return nothing / 403, granted user unaffected.
- **Prod:** clone rehearsal + scheduled window + Neo's explicit go (unchanged discipline). Same no-op-at-apply argument holds (prod client-scope rows expected ≈0; feature is 6 days old — verify with the same baseline probe first).
- **Rollback:** policies are droppable (recreate prior policy text — in-repo history), columns/table additive and ignorable; app-side wall short-circuits to no-op when no client is walled, so `memory_wall=false` per client is the instant functional kill-switch (no redeploy).

## 5. Verification ledger (this session)

- Typecheck + unit specs: see PR. Static fail-closed scan added to CI-run spec set.
- Dev E2E wall proof: **pending dev deploy of this branch** (no live surface can exercise it until the migration + code are deployed together).
- Prod confidentiality baseline: **blocked** (no prod creds this session) — run the `hermes-memkg-confbase2` probe equivalent in prod before the prod window.
