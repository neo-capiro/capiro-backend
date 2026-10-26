## 1. Claude handles the harness

The quality bar is Claude's own. Answer quality comes from the whole harness, not only the model: its system prompt, built-in tools, subagents, skills, context management and compaction, and session handling.

- Run `@anthropic-ai/claude-agent-sdk` with its **full harness** and the Claude Code system-prompt preset, plus a short Capiro/Meri append. Don't replace the preset with our own prose.
- Do not rebuild what the SDK or AWS already does: model calls, retries, streaming, the tool loop, context management and compaction, session resume/fork, per-run turn and spend limits, AWS credentials.
- The real Claude SDK calls Bedrock directly using its narrowly scoped AgentCore runtime IAM role. Preserve the full preset, native tools, subagents and all 14 skills.
- Capiro data reaches Claude as **tools** (rule 4), not as a custom retrieval layer around the model.

Spec and plan: `phases/wave2/WAVE2-00-CLAUDE-NATIVE-HARNESS-SPEC.md`. It is **Wave 2 item 0**, and it comes before every other item that touches the runner, the proxy or authority.

## 2. Simple, standard architecture

```text
browser -> control (current access, conversation/run ownership, durable events)
        -> AgentCore Runtime V1 (isolated conversation session; actual Claude SDK) -> Bedrock
                                      -> tool gateway -> Core
control -> existing durable SDK SessionStore and artifact owners
control -> Temporal for required durable runs, schedules and background work
```

- **Core is the gatekeeper for Capiro data.** Tenant, member, client and wall rules remain server-side in Core. Check current access at admission and actual tool/data/artifact access; revocation must also prevent use of previously loaded privileged context. Do not duplicate policy in the harness.
- Reuse one isolated environment only for the same immutable tenant/actor/conversation and approved General/client scope. Serialize turns; stop idle compute and restore exact SDK transcripts and artifacts from their durable owners. A Runtime session ID is not authorization or durable storage.
- Keep the SDK's per-run turn/spend limits and one canonical tenant cap/usage owner. Preserve required durable runs, schedules, consent, outcomes and uncertain-write fences; neither SDK Task tools nor a warm process replaces Temporal durability.
- **No custom warm pool, per-turn ECS task requirement, model proxy, duplicated per-hop authority, credential-minting service or spend-reservation ledger.** Use standard Runtime V1; no V2 snapshot machinery or second SDK implementation.
- Before adding a mechanism, identify the standard feature or existing owner it uses. Before deleting a wrapper, prove the retained lower-layer behavior with meaningful positive/negative tests. Do not remove canonical authorization, idempotency or durable outcomes as “extra security.”

## 3. Leave no dead code behind

A change is not done until what it replaced is gone.

1. **Delete in the same PR** everything the change makes unused: code, tests, fixtures, docs, config keys, env vars, feature flags, IAM statements, ALB rules, secrets, task definitions, CloudFormation resources, kit steps, alarms and metric filters. Applied database migrations are history: never edit them. Drop tables only through a separately reviewed forward migration after a snapshot; this hosting migration does not itself authorize schema/data removal.
2. **Temporary diagnostics come out before merge** of the fix they were added for. A log line stays only as named product telemetry that someone reads.
3. **No code behind a flag nothing turns on.** The "source-complete, activation-held" status is retired for code we don't intend to ship. Dark features need an owner and a date, or they are deleted.
4. **No** commented-out code, `legacy` or `_old` copies, compatibility shims for removed things, or "superseded" stubs.
5. **Show proof in the PR:** list the identifiers, files and resources deleted, with a search proving no executable/active caller remains; label immutable historical references, and explain any drop in test count.
6. **Old plan tickets for removed mechanisms are closed as superseded**, not implemented and left dormant. See `source-of-truth/SUPERSEDED-BY-ITEM-0.md`.
7. **Reuse before write.** Use SDK, AWS and library features first. Custom code needs one line saying what the standard option couldn't do.

## 4. Capiro data must keep working

- Capiro data is served to Claude as tools. Core remains the source: today's read families call Core at `/api/clio/tools/<operation>`, and the new tools call the same endpoints.
- Tools are hosted by **control** (the existing tool gateway) so the runner never holds the Core service secret (`x-internal-service-secret`). The runner gets only a short-lived per-run token for control, scoped to tenant, user, client, conversation and run.
- Reuse the existing read handlers under `apps/gateway/sources/*` and their typed schemas. Delete the authority, relay and measurement wrappers around them.
- Parity: every read family that works today must be reachable as a tool with the same results and the same permission outcomes. A parity checklist is part of the item 0 spec.
- Negative tests are mandatory: another tenant's data, another client's data, and walled data must not be retrievable, through chat or through tools. A General chat reads across the clients the user can already see, with each client's wall enforced per result (FINAL-PLAN decision 2).
- The original read-only first cut is historical. Neo subsequently authorized preview client-record writes and autonomous Wave 2 completion. Activate accepted writes through their existing authenticated domain/intent owners and receipts, with the actual route/configuration and effect semantics verified. This does not authorize the assistant to send external mail without the user's specific send instruction.

# Wave3 core accepted-source composition

FROM: Integration | TO: Wave3 Root / independent reviewer | TYPE: status/handoff | RE: accepted deltas on current default

Prepared 2026-10-26T01:16:01.081375+00:00. Branch `codex/wave3-core-integration-20261026`; exact base `722f094cf60e40b2fb270bb5c1e06bf66d795c42`. Product composition head `bdf342b919561f9447e23d88e37cfc46e7871a45`, tree `e4e8fb8fa5a50c9d712c9e9b5a5ac6209d32501a` before this brief/registry/status commit; final PR head/tree are supplied in the task handoff. Author commits remain in the per-PR provenance commit messages. Draft only; source composition is not independent integrated acceptance or release qualification.

## Source and ownership

- [128](https://github.com/neo-capiro/capiro-backend/pull/128): `025ae90fc7bf85c91a5f60eaf949cc7effa1d330` → `68a7dae3043353ef03e98487bf4451c6080116bb`.
- [129](https://github.com/neo-capiro/capiro-backend/pull/129): `025ae90fc7bf85c91a5f60eaf949cc7effa1d330` → `45eaba1b720849e914052fcf3d7003ac73ac27cd`.
- [134](https://github.com/neo-capiro/capiro-backend/pull/134): `45eaba1b720849e914052fcf3d7003ac73ac27cd` → `b79a168cdb75aa021c48fe328f599c2788cdae07`.
- [137](https://github.com/neo-capiro/capiro-backend/pull/137): `b79a168cdb75aa021c48fe328f599c2788cdae07` → `c739cdfd580b88d9ec131aff9dc17248a4b65eb6`.

The already merged research-wall fix83ae398e35 is preserved; Core128 contributes only remaining meeting-pagination source/test hunks. Engagement retains the exact current attachment and definite-mail-refusal changes. The firm-data test retains the current corrected assertion; its only difference from accepted128 is that assertion. MeriToolsService and the other37 accepted paths match their accepted blobs exactly. No source conflict or semantic rewrite occurred.

Domain owns the accepted Onboard delivery-claim schema/migration bytes from129; composition preserves them without executing migration. The runtime closure contract binds API manifests/lock and apps/api/prisma/schema.prisma, all unchanged from722f094; the separate Onboard schema does not change those API closure inputs. No closure regeneration or generated client rebuild was performed. New WS10 Workspace schema/controller work, MG06 indexing and WS15 newsletter receiving remain with their allocated authors; this composition contains only their accepted predecessors.

Reused source evidence: Core128 predecessor acceptance;129 reported177 distinct Workspace tests including4 PostgreSQL cases and19 Onboard tests including3 native claim/migration cases, type/build and13 mutants. Core134 independent final timing/cross-instance1PASS/15unselected plus prior23PASS/3HTTP excluded; do not sum separate scopes. Core137 reviewer19PASS, with author71/typecheck/three mutants retained under the report's provenance limits. Those are reused author/reviewer results, not Integration-run tests. Onboard migration activation, full WS05/06/12/ML24, deployed stable key/replicas, E29 and authenticated integrations remain open.

## Checks and limits

Integration ran ordinary Git base/head/path and blob comparisons, explicit overlap comparisons, current-default preservation checks and `git diff --check`, all PASS. Source proof uses Git blobs and does not normalize away product differences. No product behavior test was newly executed; accepted unchanged owner evidence is reused. No new executable product test, so mutation N/A for this composition. Source/record inspection scripts are task-local, not a new repository qualification framework. The exact commands and source comparison output remain in the existing Integration work/output directories.

No dependency install, service/cache mutation, shared port, build, PostgreSQL, migration, image, cloud, model call, provider operation or deployment occurred. Existing environments/checkouts remain preserved. Required affected integration review is NOT RUN at this new head; Root allocates the existing independent reviewer and necessary gate owner. Release owns build/image/smoke/scan, protected database actions, deployed configuration, rollout and rollback; Acceptance owns bounded authenticated real-path checks. Missing or unknown observations are not PASS. No external send or public coordination comment is requested.

Standing requirements, current Wave3 brief/lane plan, PROCESS6.1–6.3, implementation standards, supersession and actual WS05/06/07/12, ML24, MT09 and MF16 tickets/scenarios were read. Item0 removes obsolete per-hop authority mechanisms; Decision11/O143 removes Workspace approvals while retaining sharing/current authorization and durable receipts. Root remains the sole orchestrator; helpers xhigh. In-scope decisions proceed without new approval ceremony. Full SDK/RuntimeV1/Core walls, durable session/artifact/user/firm memory and retained Temporal guarantees remain intact.

## Changed paths

- `apps/api/src/engagement/engagement.service.ts`
- `apps/api/src/engagement/portfolio-a1.safety.spec.ts`
- `apps/api/src/meri/meri-meeting-read.helpers.spec.ts`
- `apps/api/src/meri/meri-meeting-read.helpers.ts`
- `apps/api/src/meri/meri-tools.firmdata.spec.ts`
- `apps/api/src/meri/meri-tools.service.ts`
- `apps/onboard-api/prisma/migrations/20261025120000_onboard_email_delivery_claim/migration.sql`
- `apps/onboard-api/prisma/schema.prisma`
- `apps/onboard-api/src/email/email.postgres.spec.ts`
- `apps/onboard-api/src/email/email.service.spec.ts`
- `apps/onboard-api/src/email/email.service.ts`
- `apps/onboard-api/src/lifecycle/lifecycle.delivery-counts.spec.ts`
- `apps/onboard-api/src/lifecycle/lifecycle.service.ts`
- `apps/workspace/src/document-agent/document-agent.service.spec.ts`
- `apps/workspace/src/document-agent/document-agent.service.ts`
- `apps/workspace/src/documents/documents.service.ts`
- `apps/workspace/src/drafts/draft-write.ts`
- `apps/workspace/src/drafts/drafts.controller.ts`
- `apps/workspace/src/drafts/drafts.service.ts`
- `apps/workspace/src/drafts/dto/save-draft.dto.ts`
- `apps/workspace/src/drafts/ordinary-draft-save.spec.ts`
- `apps/workspace/src/drafts/ordinary-draft-save.ts`
- `apps/workspace/src/generation/generation.service.spec.ts`
- `apps/workspace/src/generation/generation.service.ts`
- `apps/workspace/src/hillday/a1-export-revocation.spec.ts`
- `apps/workspace/src/hillday/dto/hillday.dto.ts`
- `apps/workspace/src/hillday/hillday-document.service.ts`
- `apps/workspace/src/hillday/hillday-export.service.spec.ts`
- `apps/workspace/src/hillday/hillday-export.service.ts`
- `apps/workspace/src/hillday/hillday-library-access.spec.ts`
- `apps/workspace/src/hillday/hillday-library-query.spec.ts`
- `apps/workspace/src/hillday/hillday.controller.ts`
- `apps/workspace/src/hillday/hillday.types.ts`
- `apps/workspace/src/newsletters/newsletter.controller.ts`
- `apps/workspace/src/newsletters/newsletter.service.ts`
- `apps/workspace/src/newsletters/newsletter.spec.ts`
- `apps/workspace/src/versions/versions.service.ts`
- `apps/workspace/test/ordinary-save-postgres.int-spec.ts`
- `packages/shared/src/newsletter.ts`
- `docs/wave3-integration-20261026/BRIEF.md` — this source handoff.
