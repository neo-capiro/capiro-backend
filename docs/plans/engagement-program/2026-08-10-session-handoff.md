# Engagement + Outreach V3 — Session Handoff

**Handoff date:** 2026-08-10
**Repository:** `neo-capiro/capirov2`
**Read first in a new session:** this file, then `canonical-remaining-work-plan.md`
**Current decision:** KEEP GOING — DO NOT MERGE OR SHIP UNTIL THE CURRENT EXACT-HEAD GATES AND INTERNAL ACCEPTANCE ARE RESOLVED.

## 1. What this handoff covers

This handoff combines the current truth for:

1. the broader Engagement API/Fargate extraction program;
2. the Outreach V3 revised implementation stack;
3. the newly accepted Outreach standalone visual contract;
4. the remaining generation/draft/approval/preflight/send work;
5. the eventual Engagement ownership and customer cutover.

Do not treat Outreach V3 Phase 6 completion as completion of the entire Engagement program.

## 2. Current Outreach V3 PR stack

Always re-resolve the PR heads before doing work. The SHAs below are reference points from this handoff; documentation commits may move the top head.

| Revised phase | PR | Branch | Reference head | State |
|---|---:|---|---|---|
| 1 — shared foundations | #822 | `agent/outreach-v3-p1-shared-foundations-gpt56-complete` | `cf0aa80d8d16fbd1e775fc054e8de34570535e23` | open draft, unmerged |
| 2 — Campaign Spec + deterministic command engine | #862 | `agent/outreach-v3-p2-campaign-state-command-engine` | `89b0a8e08e1cfcc7210a8684335faf6f8405bdf2` | open draft, unmerged |
| 3 — thin reasoning gateway | #881 | `agent/outreach-v3-p3-reasoning-gateway` | `b043a995928314f7085b7f9df94bdba02cee9640` | open draft, unmerged |
| 4 — target intelligence | #883 | `agent/outreach-v3-p4-target-intelligence` | `208dae611d9f5636f3b7507f8782ff7cc864c4ed` | open draft, unmerged |
| 5 — governed context + strategy | #890 | `agent/outreach-v3-p5-context-strategy` | `835cdef35cd8ecb23faf1b100ecfc743bcd31128` | open draft, unmerged |
| 6 — conversational planning UI | #891 | `agent/outreach-v3-p6-conversational-ui` | `d61900756fa4fc1a04466df73c7a12a46195ea4b` before this handoff-doc sequence | open draft, unmerged |

Phase 4 is stacked on Phase 3; Phase 5 on Phase 4; Phase 6 on Phase 5. Do not flatten or merge them without first verifying current ancestry and the intended merge strategy.

## 3. Phase 6 visual authority changed on 2026-08-10

The product owner supplied:

```text
Outreach V3 (standalone)(2).html
```

It supersedes the earlier Phase 6 Figma layout **where the two disagree about layout or interaction placement**.

Frozen SHA-256:

```text
84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453
```

Canonical repo contract:

```text
docs/plans/outreach-v3/revised-phase-6-standalone-layout-supersession.md
```

Current production-source implementation on #891 was changed to match these rules:

- one centered workbench;
- no permanent desktop conversation/work split;
- six visible stages: Goal → Targets → Delivery → Context → Drafts → Send;
- Sponsor remains an internal checkpoint inside Goal;
- Strategy/planning remains an internal checkpoint inside Drafts;
- Campaign Brief is a collapsible strip;
- Meri's live conversation is docked across the bottom of the whole workbench;
- live Meri question remains visible beside the composer;
- transcript expands upward over the workbench;
- target profile remains inside the Targets workbench;
- mobile is conversation-first with >=44px targets/actions;
- proposal effects are named and require explicit Apply or Discard.

The earlier file `docs/plans/outreach-v3/revised-phase-6-implementation-handoff.md` predates this supersession in a few layout descriptions. If it conflicts with `revised-phase-6-standalone-layout-supersession.md`, the supersession wins.

## 4. What Outreach V3 Phase 6 actually owns

Phase 6 implements the governed planning experience through the generation boundary:

- canonical campaign session/bootstrap;
- goal/read-back;
- optional sponsor scope;
- target criteria, recommendations, Directory/client/recent/manual sources;
- explicit Add / Added / Remove / Not relevant target behavior;
- target profile, role/email health, source freshness, relationship metadata, coverage;
- delivery-pattern and personalization choices;
- governed context search/review;
- writing guidance vs factual evidence separation;
- target-specific context scope;
- deterministic strategy review;
- reasoning conversation;
- pending proposals with explicit Apply/Discard/stale handling;
- reasoning-outage deterministic fallback;
- planning-complete boundary;
- Classic Outreach fallback.

Phase 6 does **not** own or enable:

- representative sample generation;
- full draft generation;
- immutable V3 draft editing/approval UI;
- preflight authority;
- test send;
- durable V3 send intent creation;
- provider delivery;
- delivery retry;
- post-send memory commit.

Typing `send it` must not send anything in Phase 6.

## 5. Current Phase 6 verification posture

Permanent repo gates exist:

```bash
node scripts/verify-outreach-v3-phase6-final.mjs --sha "$(git rev-parse HEAD)"
node scripts/verify-outreach-v3-phase4-6-final.mjs --sha "$(git rev-parse HEAD)"
```

The new standalone-layout changes occurred after earlier Phase 6 verification evidence discussed in prior sessions. Therefore the next session must **re-run exact-head validation against the newest #891 head** rather than relying on a previous marker.

GitHub Actions has repeatedly shown `startup_failure` with zero jobs for this repository. A zero-job startup failure is an environment failure, not passing or failing product evidence.

Before merge recommendation, require:

- exact-head Phase 6 typecheck/tests/build/diff gate;
- combined exact-head Phase 4–6 gate;
- no open P0/P1/blocking-P2 findings;
- deployed authenticated browser acceptance on the internal canary;
- independent fresh-context review.

## 6. Broader Engagement API extraction state

The dedicated `engagement-api` service is intended as the request-serving home for the **whole Engagement Manager**, not just Outreach.

### Already landed into repository history

**PR #755 — Engagement API Phase 1 local runtime** was merged.

Key properties:

- second NestJS runtime for `engagement-api`;
- same Engagement source tree;
- same database;
- no second domain implementation;
- shadow mode with background actions/callbacks/Recall/external actions disabled;
- authoritative local parity/containment evidence recorded in its handoff.

Canonical handoff:

```text
docs/plans/engagement-api/phase-1-handoff.md
```

**PR #781 — Engagement API Phase 3 full existing UI parity preview** was merged. Accepted Phase 2 dark-runtime work is in its ancestry.

Key properties:

- full current Engagement SPA parity/preview infrastructure;
- exact route-manifest-based preview routing;
- request provenance/service identity;
- auth/tenant/role/private-record/ethical-wall parity tests;
- external actions remain denied in shadow;
- no canonical customer cutover;
- no worker/callback/Recall transfer.

Canonical handoffs:

```text
docs/plans/engagement-api/phase-3-handoff.md
docs/plans/engagement-api/phase-3-self-audit.md
```

## 7. What is NOT finished in the whole Engagement program

Do not call the entire Engagement plan complete until these are proven or explicitly retired:

1. **Capiro-internal whole-Engagement HTTP canary**
   - Meetings, Reports, Integrations, tasks/outcomes, Classic Outreach, and Outreach V3 should be exercised through `engagement-api` for the internal tenant only.
   - Customer tenants remain on the current canonical routing until a later approved cutover.

2. **Capiro-internal V3 tenant authorization**
   - replace query/session preview as the authorization boundary with server-owned tenant entitlement/allowlist;
   - direct V3 API calls from another tenant must fail closed/nonleaking;
   - existing V2 drafts remain Classic.

3. **Governed representative samples and full generation**
   - recipient-scoped Evidence Packets;
   - correct target/client context isolation;
   - async/versioned parity;
   - sample-first flow for larger audiences;
   - interrupted generation resumes without rewriting completed drafts.

4. **Immutable V3 draft lifecycle**
   - exact immutable version IDs;
   - editing/regeneration/revert creates a new version;
   - approval applies to exact version only;
   - held/dirty/stale/failed statuses distinct;
   - provenance/claim-level remediation visible.

5. **Deterministic preflight + durable send intent**
   - only exact approved versions eligible;
   - recipient collision, sender, attachment, audit, address, and version checks;
   - durable intent before external provider call;
   - partial eligibility and held-out drafts explicit;
   - test send governed separately.

6. **Provider outcomes**
   - sent/accepted/failed/unknown distinct;
   - provider correlation IDs retained;
   - unknown never automatically retried;
   - partial-send reconciliation and safe manual follow-up.

7. **Context-correctness matrix and scale**
   - recipient context isolation;
   - async Intel snapshots without bearer tokens;
   - bounded 40-recipient generation;
   - group/common-fact audience policy;
   - truthful “available vs actually used” provenance;
   - permanent release-gate matrix.

8. **Background ownership transfer**
   Transfer independently, never as an incidental HTTP cutover:
   - background worker timers;
   - OAuth callbacks;
   - Recall webhook/continuation ownership;
   - sync schedulers/subscriptions;
   - external mail/provider action owner;
   - any notetaker ownership paths.

9. **Customer canonical cutover**
   - only after internal canary and independent validation;
   - preserve fast rollback;
   - one active owner per route/background subsystem;
   - no broad customer exposure merely because code is merged.

10. **Legacy retirement**
   - only after route telemetry and acceptance prove no required first-party traffic depends on the legacy owner/path;
   - do not delete Classic Outreach or historical data as rollback.

## 8. Recommended Capiro-internal canary architecture

When the product owner explicitly authorizes AWS/internal enablement, prefer:

```text
Capiro internal tenant — normal Engagement HTTP requests
              ↓
        engagement-api Fargate
              ↓
Meetings / Reports / Integrations / tasks / Classic Outreach / Outreach V3
```

But initially preserve current ownership for:

```text
background workers
oauth callbacks
Recall webhook/continuations
sync schedulers
external mail/provider actions
```

Outreach V3 itself should be automatically available only for the Capiro internal tenant through a **server-owned tenant gate**. Do not use email address, tenant display name, query parameters, or preview headers as the security boundary.

External/customer tenant negative control:

- Classic/current experience only;
- no V3 UI entitlement;
- direct `/api/engagement/outreach-v3/**` returns nonleaking denial/404;
- spoofed preview parameter/header cannot grant access.

## 9. Next-session startup procedure

A new session should execute this sequence before making substantial changes:

1. Read `docs/plans/engagement-program/README.md`.
2. Read this handoff.
3. Read `canonical-remaining-work-plan.md`.
4. Resolve current `main` SHA.
5. Resolve PRs #822, #862, #881, #883, #890, #891 and confirm their current ancestry/status.
6. Resolve the **current** #891 head; do not reuse the SHA printed above if docs/repairs moved it.
7. Inspect PR #891's current CI/workflow run. Treat zero-job startup failures as environment-blocked.
8. Run the exact-head Phase 6 final verifier and combined Phase 4–6 verifier in a real execution environment if CI is not authoritative.
9. Repair all new P0/P1/blocking-P2 findings before requesting merge/deploy.
10. Audit the source-plan registry against current code before beginning generation/send work. Never execute stale file/line anchors blindly.
11. Do not merge or deploy without current-session owner authorization.

## 10. Recommended work order after Phase 6 exact-head verification

```text
A. Capiro-internal tenant gate + whole-Engagement HTTP canary
B. deployed browser acceptance + parity repairs
C. representative samples + recipient-isolated governed generation
D. immutable drafts + exact-version approvals
E. deterministic preflight + durable send intents
F. provider outcomes + unknown/no-auto-retry reconciliation
G. async/group/provenance correctness matrix + CI gate
H. one-by-one background ownership transfer
I. customer canary / canonical cutover
J. legacy retirement
```

Do not skip A/B and immediately expose the new stack to customers.

## 11. Safety invariants to carry into every new phase

- canonical Campaign Spec is server-owned and versioned;
- model cannot directly mutate state or send;
- proposals require explicit Apply;
- client/tenant/ethical-wall authorization fails closed;
- target/context refs are server reauthorized;
- target-specific context is never shared across recipients;
- writing guidance is not evidence;
- immutable exact draft versions govern approval and sendability;
- durable send intent precedes provider delivery;
- unknown delivery is never automatically retried;
- provider/model/network calls stay outside DB transactions;
- one active owner per background/external subsystem;
- Classic remains the rollback until an explicit retirement gate.

## 12. Current merge/deploy recommendation

```text
KEEP GOING
DO NOT MERGE YET
DO NOT ENABLE CUSTOMER V3
DO NOT TRANSFER BACKGROUND OWNERSHIP YET
```

Reason: the latest standalone-layout changes must be revalidated on the exact current #891 head, internal whole-Engagement/V3 deployment acceptance is not yet proven in this handoff, and later generation/send/background/cutover phases remain.
