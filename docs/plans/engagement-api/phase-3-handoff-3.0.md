# Phase 3 Handoff — Micro-Session 3.0

**Repository:** `neo-capiro/capirov2`
**Branch:** `agent/engagement-api-phase-3-full-ui-parity`
**Worktree used:** `C:\Users\neoma\Downloads\capiro-eng-p2`
**Head SHA:** `aafb5eea01a0386983c3f7730861b5fa5c63c4cb`
**Status:** 3.0 complete and committed. 3.1–3.18 remain.

---

## Read this first

**Phase 2 is code-complete AND live-deployed**, not just code-complete. That's
different from every prior phase transition in this program. Gates B,
D-part-1, and C are all live in `capiro-dev` (account `967807252336`,
`us-east-1`) as of 2026-08-06: ECR repo, empty-then-filled target group, the
priority-6 preview ALB rule, and the Fargate service itself, running 1/1,
target healthy, verified with one safe preview read.

**No independent reviewer has validated the live deploy.** Phase 2's own
2.14 checkpoint validated code-complete, before any AWS credential existed
in this program. There is no live-deploy equivalent yet. If you're picking
this up fresh, that's a real gap, not a formality — read
`docs/plans/engagement-api/phase-3-input-lock.md` §1 before assuming Phase 2
is fully closed out.

**Nothing in Phase 3 itself has touched AWS yet.** 3.0 is documentation only.

---

## One command

```bash
pnpm verify:engagement-phase-0
pnpm verify:engagement-phase-1
pnpm verify:engagement-phase-2
```

All three pass clean on this branch (34/0/1-skip on Phase 2; the one skip is
the prototype-drift gate, which needs `OUTREACH_V3_PROTOTYPE_PATH` set — see
Phase 2's own handoff for that variable). `pnpm turbo run typecheck` fails
with the same four pre-existing `TS6059` errors `main` already has
(`apps/api/src/defense-budget/**`); this is documented, not a regression, and
not gated in `verify:engagement-phase-2` for exactly that reason.

---

## What exists

| Session | Deliverable | Status |
|---|---|---|
| 3.0 | Input lock: base SHA, Phase 0/1/2 acceptance, three locked input hashes | **done**, 1 commit |
| 3.1 | UI surface / API consumer inventory | not started |
| 3.2–3.18 | everything else | not started |

### Commits on this branch (from Phase 2, carried forward, plus 3.0's own)

```text
aafb5eea docs(engagement): Phase 3 input lock (3.0)              <- Phase 3's own
3841a5ee fix(engagement): dedicated logs KMS key and correct data-key ARNs (2.16)
64f0d41a fix(engagement): accept reviewed perl-base findings on the CVE gate (2.16)
17cdcb5c fix(engagement): patch base-image CVEs and fix scan-digest resolution (2.16)
a7e508e3 fix(engagement): split appConfigSecretArn into four whole secrets (2.15)
955e9f86 fix(engagement): split DB secrets to match live discovery (2.15)
```

Everything above `aafb5eea` is Phase 2 work, fast-forwarded onto this branch
rather than rebased or cherry-picked — the two branches share history exactly.

---

## Non-obvious operational notes

Carried forward so they don't get rediscovered the hard way.

1. **Live config file lives outside the repo, deliberately.** The filled
   `capiro-dev` config used for every live command in this session is at
   `C:\Users\neoma\AppData\Local\Temp\claude\...\scratchpad\engagement-api-dev-config.json`
   — a session scratchpad path, not committed. It is **not durable** — if you
   are a fresh session, that exact file will not exist for you. Reconstruct
   it from `docs/runbooks/engagement-api-infra-config.example.json` plus the
   real values recorded in this handoff and in the input-lock doc. Do not
   guess any value; every one below was confirmed by a live read-only AWS
   call.
2. **`kmsKeyArns.logs` no longer exists in the config schema.** The Service
   stack creates its own log-group encryption key now (see commit
   `3841a5ee`). Do not try to add it back.
3. **`kmsKeyArns.data` real values, discovered the hard way**: the Aurora
   secrets (`/capiro/dev/aurora/master`, `/capiro/dev/aurora/app`) are
   encrypted with `arn:aws:kms:us-east-1:967807252336:key/efe8a18d-192e-4f30-8eea-b3f65ae7755e`.
   The two Clerk secrets are encrypted with
   `arn:aws:kms:us-east-1:967807252336:key/f47b4c53-b9c0-4d91-ad57-4d882f87767e`.
   Neither is the general-purpose `alias/capiro-dev` key
   (`key/ffcfa6a7-dcf9-404b-924e-fff133b43450`) — that key is used for ECR
   only. Check `aws secretsmanager describe-secret --query KmsKeyId` before
   trusting any assumption about which key encrypts which secret; don't
   reuse a "looks general-purpose" key without verifying.
4. **Git Bash mangles leading-slash AWS resource names.** `aws logs
   describe-log-streams --log-group-name /capiro/dev/engagement-api` fails
   with a regex `InvalidParameterException` unless you set
   `MSYS_NO_PATHCONV=1` first — Git Bash rewrites the leading slash into a
   Windows path otherwise. Same failure class documented in Phase 2's own
   handoff for the discovery script's `mktemp -d`.
5. **`docker buildx build --push` on this base image produces an OCI image
   INDEX by default** (the real manifest plus a build-provenance attestation
   manifest), because modern buildx enables provenance/SBOM attestations by
   default on the `docker-container` driver. ECR basic scanning cannot scan
   an index (`UnsupportedImageTypeException`) — it silently scans the child
   manifest instead, so `describe-images --image-ids imageTag=X` and
   `describe-image-scan-findings --image-id imageTag=X` both resolve to the
   *index*, which was never scanned, and report `scanStatus: none` forever.
   Fixed with `--provenance=false --sbom=false` on push (commit `17cdcb5c`).
   If you see "scan findings are not available" from
   `engagement-api-image.sh verify-scan` again, check the manifest media
   type first (`describe-images --query
   imageDetails[0].imageManifestMediaType`) before assuming the scan is
   slow — it may be scanning a digest you're not looking at.
6. **ARM64 image builds under QEMU emulation on this machine take 5–10+
   minutes** (the first build did; cached layers cut later builds to
   1–2 minutes). Always run `engagement-api-image.sh build`/`push` with
   `run_in_background`, not in the foreground — the 10-minute foreground
   timeout will kill an uncached build partway through, though the buildx
   builder container persists layer cache across the killed process, so a
   retry picks up where it left off rather than starting over.
7. **A log group with `removalPolicy: RETAIN` survives a CloudFormation
   rollback and blocks the next `cdk deploy` attempt** with "resource
   already exists." If a Service stack deploy rolls back after the log group
   was already created, check `aws logs describe-log-streams` on it before
   retrying — if it's empty (no task ever wrote to it), it's safe to
   `aws logs delete-log-group` and retry; if it has real log data, don't.
8. **ECS Deployment Circuit Breaker rolls back the whole stack**, not just
   the service — CloudFormation reports it as a generic
   `AWS::ECS::Service` `CREATE_FAILED` with no hint about *why* the task
   failed to stabilize. Always check `aws ecs describe-tasks` on a stopped
   task's `stoppedReason` (or `list-tasks --desired-status STOPPED` if the
   service itself is already gone) before assuming the container crashed —
   in this case it never even started; the execution role couldn't decrypt
   a secret.
9. **The Service stack CDK class docstring and two tests assert exactly which
   resources it may create.** If you add anything else the stack creates
   directly (not imported), you will hit three separate failures in this
   order: the CDK unit test's `resourceCountIs` isolation check
   (`engagement-api-service-stack.spec.ts`), the synthesized-template safety
   verifier's `FORBIDDEN_RESOURCE_TYPES` list
   (`verify-engagement-phase2-template.mjs`), and its negative-control spec.
   All three need the same kind of precise, exact-match exception the
   `LogsKey` fix used — never widen a check by deleting it.
10. **Background-task completion notifications in this environment have
    reported the wrong exit code twice** (said "exit code 0" when the
    command's own recorded exit code was 1). Always read the actual output
    file / log, never trust the notification summary alone, before deciding
    a gate passed.

---

## Real defects found and fixed during Gate C (for context, not to redo)

1. `dbConnectionBudget.alarmThreshold` (90) exceeded its own safe-ceiling
   formula (`floor(databaseMaxConnections * 0.8)` = 89 at
   `databaseMaxConnections: 112`). Fixed to 85.
2. Scan-digest resolution — see note 5 above.
3. 8 real Critical/High CVE findings, all Debian `perl-base` (Essential,
   already latest-patched, never invoked by this serve-only image). Reviewed
   and accepted by exact CVE ID in `engagement-api-image.sh`'s
   `ACCEPTED_FINDINGS`, not a baseline-count bump — a *different* CVE on
   `perl-base`, or any finding on any other package, still fails the gate.
4. Logs KMS key — see note 2 above.
5. Data KMS keys — see note 3 above.

---

## What's next

**3.1 — Inventory current UI surfaces and API consumers.** Builds the
authoritative manifest of every Engagement route, component, and API request
Phase 3 must prove parity for. Pure code/analysis, no AWS, no live session.
See the full micro-session plan (`phase-3-engagement-api-full-existing-ui-parity-micro-sessions.md`,
hash locked in the input-lock doc) for its exact deliverables and tests.
