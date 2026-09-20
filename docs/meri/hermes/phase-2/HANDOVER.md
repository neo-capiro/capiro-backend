# Meri ⇄ Hermes — Phase 2 handover

**Written 2026-09-20 at the close of the Phase 1 deploy session.** Phase 2 is authorised to begin.
Phase 1 detail: `../phase-1/PHASE-1-STATUS-2026-09-20.md`. Accepted interfaces:
`../phase-1/phase-2-handoff.md`.

Every load-bearing claim below was independently re-verified against the code by six agents before
this file was written. Where that verification **contradicted** what the Phase 1 session believed,
the corrected version is what you see, and the correction is called out — because several of those
beliefs are written down elsewhere in the repo and are wrong.

---

## 0. The one thing that changes your plan

**Phase 1's central safety premise is false today.** `../phase-1/deployment-validation-and-rollback.md`
§8 says the runtime exposes no external business writes, and defers re-checking that to Phase 2. The
re-check has now been done, and it does not hold:

1. **The broker is not the runtime's effect boundary.** Meri sends **no tool restriction** on
   `POST /v1/runs`, and the worker image ships `disabled_toolsets: []`. The full hermes-api-server
   toolset is live inside the worker: `web_search`, `web_extract`, **`terminal`**, **`execute_code`**,
   `write_file`/`patch`, `browser_*`, `delegate_task`, `cronjob_manage`, `manage_connections`.
2. **The worker security group permits HTTPS egress to `0.0.0.0/0:443`.**
3. The only brake is an approval gate that fires on *guarded terminal commands only*, and its records
   are Hermes pending-interactions — **not** `MeriActionProposal` rows.
4. Separately, `meri_publish_artifact` does a real S3 `PutObject` to the shared `ASSETS_BUCKET` — an
   effect no database rollback undoes.

So the sentence "rollback cannot un-send something the runtime never had the power to send" is **not
established**. The broker's six-tool surface is what Meri governs; it is not what the worker can do.

**This is latent, not live** — the pilot gate is closed, so no run can be admitted. But it is the
**shipped Phase 1 configuration**, and it becomes live the moment the gate opens, before Phase 2 adds
a single line of mail/MCP code.

> **Disclosure:** a ~10-minute validation window on 2026-09-20 did open the gate for `capiro-internal`
> and route one real turn to a worker in this configuration. The run fenced itself in ~1.2 s on an
> authorization-version mismatch and did nothing else, and the worker had `HERMES_EXEC_ASK=1`. But the
> window was opened without this capability surface being understood. Treat it as a near-miss.

**Your first deliverable should be constraining the worker's toolset to what Meri actually governs**,
before anything else. `disabled_toolsets` in the worker image, and/or a per-run tool restriction on
`POST /v1/runs`, is the smallest fix.

---

## 1. Read this before you touch anything

### 1.1 `capiro-dev` IS production
Account `967807252336`, us-east-1. ALB rule **priority 10** routes `/api/*` with **no host condition**,
so `os.capiro.ai` and `app.capiro.ai` are the same API service against the same database. **No staging
surface exists.** Verified against the ALB, not inferred from naming.

### 1.2 Production moves hourly — re-check ancestry twice, through the service
`main` moved four times in one session; production was deployed by another operator twice while that
session worked, going `395 → 401` underneath it.

```bash
TD=$(aws ecs describe-services --cluster capiro-dev --services capiro-dev-api \
      --query "services[0].taskDefinition" --output text)
SHA=$(aws ecs describe-task-definition --task-definition "$TD" \
      --query "taskDefinition.containerDefinitions[0].environment[?name=='GIT_SHA'].value|[0]" --output text)
git fetch origin main -q
git merge-base --is-ancestor "$SHA" HEAD && echo SAFE || echo "RE-MERGE FIRST"
```

**Never pass the bare family name** — it resolves to the latest *registered* revision, not the running
one. It once returned a SHA present in **no task definition of that family**, and acting on it would
have reverted two live PRs.

### 1.3 CI is intentionally broken
GitHub Actions is disabled **on purpose**. Every check fails in ~4 s having run **zero steps**. That is
normal. Do not fix it, do not wait for green, and **never deploy via CI** — deploys are direct
(`docker buildx --platform linux/arm64` → push → register TD → `update-service`). Consequence you
inherit: `ci-pr.yml` typechecks `apps/api` but **never runs its jest**.

### 1.4 The migrate task definition pins a stale digest
It runs `prisma migrate deploy` from whatever image that revision pins — silently skipping newer
migrations **while exiting 0**. Re-register against the fresh image, then verify literal
`Applying migration …` lines in CloudWatch. **Exit 0 proves nothing.**

### 1.5 Do not widen the production API task role
`Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ` serves all customer traffic. The refusal to widen
it stands. **But the Phase 1 justification for that refusal was imprecise — see §5.**

---

## 2. Current state

| | |
|---|---|
| `main` | `9f85daa8d`; local `C:\dev\main\git` identical (0/0) |
| Production | `capiro-dev-api:401`, `GIT_SHA=59d34053a` (#1709) |
| Hermes code deployed? | **Yes** (#1708 is an ancestor) |
| **P2-02 fix deployed?** | **NO** — on `main` (#1711), production is 9 commits behind |
| Pilot gate | **CLOSED** at all three keys |
| Migrations | All 5 applied, verified by literal `Applying migration` lines |
| Validation tasks running | zero |

> **Do not open the pilot gate on any tenant until a build containing #1711 is deployed**, and not
> before §0 is addressed. Opening it first activates the pilot against a recall rail that is not
> envelope-enforced *and* a worker with an ungoverned toolset.

---

## 3. Authorization: what is solid, and two gaps that are not

**Solid — verified, do not re-litigate:**

- **P2-02 is genuinely done and non-vacuous.** `ContextPlaneRecallPort` enforces the envelope as a
  ceiling: an out-of-envelope client 404s *before* any Context Plane call; every recall is
  post-filtered; a record with a missing or wrongly-typed `clientId` is admitted only when its scope
  is not `client`; `coverage.total` no longer leaks filtered counts. **Do not "simplify" the filter at
  `meri-hermes-recall.ports.ts:114-120`** — removing either half silently reopens the leak, and two
  specs are the only thing standing there.
- **Broker fencing is correct.** Token signature/expiry → run binding → scope triple
  (`tenantId`/`actorId`/`executionScopeId`, else `scope_mismatch`) → liveness, with
  `assertLiveAuthorization` called on entry **and** again before releasing results. Claims are never
  used as a permission cache; the run is re-resolved from server state.
- **A3–A7 landed** (previously "pending verification" in `phase-2-handoff.md`): `assertTool` no longer
  fails open on an empty allow-list, the tool budget is atomic in one guarded statement, and
  `MUTATING_TOOLS` is an exhaustive **fail-closed** classification — a new tool cannot compile
  unclassified. **Preserve that property**; it is what stops a Phase 2 write tool defaulting to
  permitted.

**Gap 1 — `meri_fetch_attachment` is not envelope-scoped.** (`meri-hermes-broker.service.ts` ~`:594`.)
It is scoped to **tenant + actorId only** — no `authorizedClientIds`, no `conversationId`. Meri's own
path enforces `assertAttachmentConversation` for the same rows; the broker does not, so the
agent-facing boundary is **strictly weaker than the human-facing one**. Concrete: a user uploads a
document in a chat filed to client X, later loses the client-X wall grant, and a run whose envelope
excludes X can still pull those bytes if it knows the attachment UUID. Exploitability is gated only by
UUID guessability, which is not an authorization control. **"The recall rail is envelope-enforced"
must not become "the broker is envelope-enforced."**

**Gap 2 — F-2's fail-soft changes class under Phase 2.** Session invalidation is `.catch()`-logged
(`meri-hermes-runtime.adapter.ts` ~`:653-660`), so a failed invalidation can hand the next attempt the
fenced session. Today the blast radius is bounded: a leaked transcript can taint reasoning and output
text, but every tool re-enters `authorize()`, output goes to the same user, and both application
writes are in-tenant and reversible. **Add an external write tool and the resumed transcript becomes an
exfiltration channel.** The broker verifies the *caller* is authorized; it has no mechanism to verify
that the *content* is authorized to leave. Its failure branch is untested.

---

## 4. The pilot gate — how it actually works

**Three keys, all required:** `MERI_HERMES_ENABLED==='true'` (env) + canonical tenant UUID in
`MERI_HERMES_PILOT_TENANT_IDS` (env) + `clioFeatureFlags['meri.hermesRuntime']===true` (**database,
defaults false**). Keys 1+2 open with key 3 false returns **404** — verified live.

**Seven operational traps, all verified:**

1. **`meriHermesRuntimeActive` (`meri-hermes-flags.ts:55`) has ZERO callers outside its own spec.**
   Production routing goes through a parallel reimplementation,
   `MeriFeatureFlagsService.isMeriHermesRuntimeEnabled` (`meri-feature-flags.service.ts:95-99`). They
   agree today. **Any gate change must edit both, and a green `meri-hermes-flags.spec.ts` proves
   nothing about the deployed path.** Add coverage against the service.
2. **60-second cache on key 3 only** (`CACHE_TTL_MS = 60_000`). Keys 1–2 are read from `process.env`
   per call. Do not conclude "the flag didn't take" within the first minute of a flip *or a rollback*.
3. **Fails closed on DB error** — `catch { return defaultValue }` with `false`. A Postgres blip
   silently routes pilot turns back to V3/legacy. Expect this in evidence; don't misread it.
4. **The gate is admission-only, not a drain.** `stop`, `events`, `runs/:id` and
   `conversations/:id/active` are deliberately **ungated** (ownership only) so a closed gate cannot
   strand live workers. Worker→broker traffic authenticates by signed worker token, not the gate.
5. **Impersonation reaches the pilot.** A `capiro_admin` with an active impersonation session into the
   pilot tenant gets `ctx.tenantId` = pilot tenant and lands on Hermes. Say this out loud before any
   pilot window.
6. **A slug in the env var closes the pilot silently.** Non-UUID entries are dropped with no log, so
   `MERI_HERMES_PILOT_TENANT_IDS=capiro-internal` parses to an empty set and looks exactly like "the
   flag isn't working". Canonical UUID: `17b63099-bc0f-4ac5-b596-496161e9481e`. Also,
   `MERI_HERMES_ENABLED` is compared **untrimmed** — a trailing space means off.
7. **Flipping key 3:** run the migrate TD with command override
   `["set-tenant-flag","--slug","capiro-internal","--flag","meri.hermesRuntime","--value","true","--commit"]`
   **and `TMPDIR=/dev/shm`** in the container override, or it dies on `mkdir '/app/tmp/tsx-1001'`.
   Dry-run is the default.

---

## 5. V6 and the provisioning path — corrected

**The Phase 1 claim "V6 requires `ecs:RegisterTaskDefinition`" is imprecise.** Verified: the lifecycle
service issues exactly seven AWS commands — ECS `DescribeTaskDefinition`, `RegisterTaskDefinition`,
`RunTask`, `DescribeTasks`, `StopTask`; EFS `DescribeAccessPoints`, `CreateAccessPoint` — and no IAM
call. `RegisterTaskDefinition` is **skipped whenever `workerState.taskDefinitionArn` is already set**,
so it is a *first-provision bootstrap step that can be done out-of-band*. V6's actual subject — the
`provision()` catch path, the failure metric, the `failed` row and the orphan task — needs only
`RunTask` + `DescribeTasks` + `StopTask`, all cluster-scopeable. `iam:PassRole` is required by
`RunTask` regardless, and scoped to the two `capiro-hermesval-*` role ARNs its escalation ceiling is
those two roles, not arbitrary privilege.

**But the IAM grant would not buy the gate anyway.** V6's pass condition includes "no stray volume",
and **nothing in the codebase ever calls `DeleteAccessPoint`**. And a provision that fails *after*
`RunTask` loses the new task ARN (`service:437` vs `:475-477`), so the "leaves no running task" clause
fails on the merits. **V6 is not IAM-blocked; it is blocked by two real defects.** Fix those.

**Still do it the right way:** move provisioning off the customer-facing request path onto a separate
task or Lambda with its own narrow role. `MERI_HERMES_WORKER_RESOLVER`
(`meri-hermes-worker-resolver.port.ts`) is already the right seam — one method,
`resolveWorker(scope) -> { url }` — and needs a second implementation, not a redesign.

### The trap in the escape hatch

`MERI_HERMES_SCOPE_RUNTIMES` (a JSON map `{"<scopeId>": {"url","apiKey"}}`) makes `forScope()` return
at `meri-hermes-runtime.client.ts:118-119`, before the only production call site of `resolveWorker()`
at `:129`. So the **request path** never provisions. **But the lifecycle service is not unreachable:**
`MeriHermesMaintenanceService` (`meri-hermes-worker-lifecycle.service.ts:959`, registered
`meri.module.ts:202`) holds it directly and calls `sweepIdleWorkers()` → `teardownIfIdle()` →
`ecs:StopTask` on a ~60 s interval **in every HTTP-serving API replica**. That path is gated only on
the five fleet env vars being present and `MERI_HERMES_MAINTENANCE_ENABLED !== 'false'` — **never on
the scope map.**

**The API needs no ECS permission today because those five env vars are unset in the deployed task
definition, not because the escape hatch disarms anything.** Set them and every replica starts calling
`ecs:StopTask` every minute.

---

## 6. Inherited open items, smallest first

1. **V5** — needs a worker token whose `authorizationVersion` matches:
   `v1:` + `sha256(role + sorted authorizedClientIds + '|' + sorted authorizedMailboxConnectionIds)`
   truncated to 16 hex (`computeAuthorizationVersion`, `meri-hermes-runtime.adapter.ts:129`); envelope
   predicate at `meri-hermes-security.port.ts:55`. Needs DB access. Hours, not days.
2. **V7** — needs a second identity in `capiro-internal`. Create a throwaway pilot user; do not use a
   real employee's account.
3. **E-7** — partial: gate transitions 404 → 503 → 200 evidenced and a real turn routed to
   `runtime: "hermes"`, but no completed answer rendered (blocked on V5).
4. **F-2 failure branch** — untested; see §3 Gap 2.
5. **V6** — via §5, fixing the two defects rather than granting IAM.

---

## 7. Environment traps already paid for

- **Shared ECS task SG has no self-referencing rule.** `sg-01def4e5c0fe44d4a` admits only specific
  ports *from the ALB SG*, so an API task cannot reach a worker on `8642` despite sharing the group.
  Presents as `503 fetch failed` and reads exactly like a worker fault. Add a dedicated SG; do not
  modify the production one.
- **Worker egress works** — subnets route `0.0.0.0/0` via NAT `nat-016e7d15424ca9f8a`. (This is also
  half of §0's problem.)
- **`HERMES_HOME=/opt/data`** is the EFS mount — persona, skills and session state live on the
  per-scope access point. `RunTask` overrides have **no `volumes` field**, so the access point is fixed
  at TD registration: one TD family per scope.
- **A plain `--force-new-deployment` leaves `GIT_SHA`/`RELEASE_SHA` on the previous commit.** Register
  a revision with the new image *and* both SHAs rewritten, or the ancestor check lies.
- **Migration timestamps run ~2 years ahead** repo-wide — a hand-written "sorts after current max"
  ratchet, not a clock. **Never renumber a subset.** CI guard landed as #1712 (inert until Actions is
  restored).
- **Host quirks:** `pkill` does not kill Windows processes — use `taskkill /PID <n> /T /F`. Set
  `PYTHONIOENCODING=utf-8` for `aws logs` or use `--output json`. AWS CLI needs `MSYS_NO_PATHCONV=1`
  and `file://C:/...`. Never run a full jest suite and an arm64 docker build together.
- **Identity:** `GET /api/me` (not `/api/users/me`, which 404s) with a Clerk **bearer** token; cookie
  auth alone returns 401.

---

## 8. Mistakes made in Phase 1 — and in this handover's first draft

- **The ancestor check was reported SAFE when it was not**; production had advanced two PRs beyond the
  branch. Hence §1.2.
- **"V5–V7 are all blocked by IAM" was wrong** — `MERI_HERMES_SCOPE_RUNTIMES` had existed since Phase 0.
  Only V6 was ever blocked, and §5 shows even that framing was imprecise.
- **A migration rename was nearly applied on a false premise** — the 2028 dates are a repo-wide
  convention across 53 migrations, not an anomaly in five.
- **This file's first draft asserted the no-external-writes premise as merely "needing a re-check."**
  The re-check found it already false (§0). Three of six verified claims came back
  `PARTIALLY_TRUE` — including two the Phase 1 session had stated confidently.
- **Delegated agents under-report.** Three of six Hermes sessions omitted non-vacuity evidence they
  were explicitly asked for; one gave a test count that did not distinguish a real container run from
  a silent skip. **Verify delegated work yourself** — every Phase 1 result was re-verified locally, and
  two would have been misleading otherwise.

---

## 9. Where things are

| | |
|---|---|
| Phase 1 status of record | `../phase-1/PHASE-1-STATUS-2026-09-20.md` |
| Accepted interfaces (with §3's two corrections) | `../phase-1/phase-2-handoff.md` |
| Authorization ledger, reconciled | `../phase-1/authorization-ledger-reconciled.md` |
| V6 / resolver analysis | `../phase-1/v5-v7-blocked-on-resolver-binding.md` (read with §5) |
| V5/V7 runbook, values resolved | `../phase-1/v5-v7-runbook.md` |
| Live pilot window evidence | `../phase-1/evidence/pilot-window/` |
| Deploy / migration / rollback evidence | `../phase-1/evidence/production-deploy/` |
| V4 state survival | `../phase-1/evidence/fargate-v4/` |
| Rollback contract (see §0 — its premise is false) | `../phase-1/deployment-validation-and-rollback.md` §8 |

**Do not activate the pilot** beyond a time-boxed `capiro-internal` window, and not until §0 is
addressed and #1711 is deployed. No customer tenant belongs in the allowlist.
