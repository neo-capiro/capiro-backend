I'll conduct a thorough read-only code review of these five operator/test/doc files, examining trust boundaries, exact joins, one-shot behavior, Clerk lifecycle, HTTPS/build/source checks, and secret handling - all grounded in the provided source code and policy.

## PASS ⭐

This is a well-architected controlled read operator with strong trust boundaries and comprehensive safety checks. Below are my concrete, source-grounded findings organized by review dimension.

---

### 1. TRUST BOUNDARIES & JOINS

**Trust boundary architecture is correctly layered:**

- **Operator input layer** (`controlled-read-operator-input.mjs:47-67`): `controlledReadSetupInput()` validates manifest namespace, target, tenant, actor UUIDs, and restricts to cases `['20', '72']` only.

- **Plan/execution join** (`controlled-read-operator-input.mjs:68-89`): `controlledReadExecuteInput()` enforces fingerprinted joins via `definitionSha256`, `physicalMapSha256`, `sourceMap` deep equality, and `planSha256` self-hash verification.

- **Setup receipt join** (`controlled-read-operator-input.mjs:90-145`): `inspectControlledReadSetupReceipt()` requires matching `operationId` across seed/reset receipts, validates CAS fields (`tenantId`, `actorUserId`, `clientId`, `caseId`, `captureRunId`), and enforces `sharedCorpusWrites === 0`.

- **Budget/plan join** (`controlled-read-operator-input.mjs:146-181`): `controlledReadBudgetInstallInput()` joins against setup receipt via `currentVerifySha256`, `captureBindingSha256`, `priorQualificationSha256`, `tenantRowVersion` - full CAS trace.

- **Live config final join** (`controlled-read-operator-input.mjs:182-246`): `controlledReadLiveConfig()` joins qualification against install receipt, deployment against expected SHAs, and build digests. Critical: source map must equal `binding.physicalMapSha256` and `setup.sourceMap`.

**Verification:** Test file (`tests/controlled-read-operator.test.mjs:180-220`) covers mutation of each join field and confirms throws with appropriate error codes.

---

### 2. ONE-SHOT/AMBIGUOUS-CREATE BEHAVIOR

**Correct one-shot semantics throughout:**

- **Materializer CLI** (`materialize-controlled-read.mjs:37-42`): Stages are sequential and cumulative - each stage requires receipts from prior stages. Receipt format `{status:"VERIFIED",containerExitCode:0,ownerReceipts:[receipt]}` is strict.

- **Exclusive creation** (`run-controlled-read.mjs:176-180`): Output directory must not exist: `mkdirSync(outRoot)` throws if exists. Claim file under `controlled-read-claims/` also uses `flag:'wx'` for exclusivity.

- **Creation intent persistence** (`run-controlled-read.mjs:244-252`): Intent is written with `retryAllowed:false` before the single `POST /api/clio/conversations`. Comment at `run-controlled-read.mjs:247` correctly states: "An ambiguous acknowledgement is reconciliation-required; neither this process nor a rerun retries it."

- **Conversation validation** (`run-controlled-read.mjs:254-265`): After creation, requires exact readback match on `/api/clio/conversations/${created.id}` and `/api/clio/conversations/${created.id}/messages` with zero messages.

- **No resume capability**: `conversationId:null` in config is required (`run-controlled-read.mjs:184`), and precreated conversations are rejected. Materializer at `controlled-read-operator-input.mjs:230-233` deliberately sets `conversationId: null` in final config.

**Verification:** Test at `tests/controlled-read-operator.test.mjs:233-235` confirms `conversationId: null` requirement.

---

### 3. TEMPORARY CLERK LIFECYCLE

**Proper scoped session management:**

- **Secret isolation** (`run-controlled-read.mjs:169-172`): `CLERK_SECRET_KEY` is captured, deleted from `process.env`, and held in memory only. Comment: "Do not pass this operator-only credential to Git, AWS or browser child processes."

- **Synthetic identity validation** (`run-controlled-read.mjs:296-333`): `assertControlledReadSyntheticIdentity()` verifies Clerk instance ID matches manifest, user has fixture namespace metadata, synthetic name pattern, fixture namespace email pattern, and organization membership with exactly one `org:member` role (not admin).

- **Short-lived ticket** (`run-controlled-read.mjs:339-348`): Sign-in token expires in 120 seconds: `expiresInSeconds: 120`.

- **Session tracking** (`run-controlled-read.mjs:348-355`): Only SHA256 of session ID is persisted: `summary.createdSessionIdSha256 = hash(createdSessionId)`. Actual session ID never leaves memory.

- **Mandatory revocation** (`run-controlled-read.mjs:398-413`): `finally` block revokes session and confirms `status === 'revoked'`. Browser cleanup failure also blocks success. Test file (`tests/controlled-read-operator.test.mjs:237-261`) verifies revocation checks.

- **No cross-session leakage**: Evidence comments at `run-controlled-read.mjs:357-360` document recovery via hash match against Clerk readback, not via stored session ID.

---

### 4. BOUNDED HTTPS/BUILD/SOURCE CHECKS

**Correct bounded verification:**

- **Source drift prevention** (`run-controlled-read.mjs:186-202`): Git working directory must be clean (`git status --porcelain === ''`), HEAD must match `operatorSourceSha`, and API SHA must be ancestor of current HEAD. Operator-only files are allowlisted, all other changes rejected.

- **Build verification** (`controlled-read-operator-input.mjs:204-223`): Requires `apiSha`, `orchestratorSha`, `webSha`, `operatorSourceSha` as 40-char SHAs. Build entries require `imageDigest` as `sha256:[64 hex]`, `buildId` matching `/^capiro-build-[a-z0-9-]+:[a-f0-9-]{36}$/`, and `buildspecSha256` as 64-char hash.

- **HTTPS bounds** (`run-controlled-read.mjs:77-127`): `creationTransport()` restricts:
  - Only one POST allowed (`++posts === 1`) to `/api/clio/conversations`
  - Reads limited to 4 requests
  - Paths bounded to `/api/me`, `/api/clio/status`, or conversation/message endpoints
  - Response size capped at 1MB

- **Browser request filtering** (`run-controlled-read.mjs:129-147`): `controlledReadBrowserRequestAllowed()` permits:
  - `origin` navigation (GET/HEAD/OPTIONS) to `os.capiro.ai`
  - POST only to `clerk.app.capiro.ai`
  - Rejects credentials in URLs, non-HTTPS, non-canonical origins

- **Web release verification** (`run-controlled-read.mjs:266-280`): `verifyWeb()` checks `window.__CAPIRO_CONFIG__.releaseSha` matches expected SHA, `webSurface === 'vnext'`, and Clerk host derivation matches `clerk.app.capiro.ai`.

- **API health/source verification** (`run-controlled-read.mjs:285-296`): Validates `/api/me` tenant/user/role match, `/api/clio/status` health/build match, and uses `readCase01BuildAuthority()` for independent build verification.

**Verification:** Test at `tests/controlled-read-operator.test.mjs:262-282` verifies browser request filtering rules including protocol, origin, method, and credential rejection.

---

### 5. NO SECRET LEAKS

**Correct secret hygiene:**

- **No bearer/token persistence** (`run-controlled-read.mjs:186-191`): `inspectControlledReadScope()` accepts bearer only via env; materialized config never contains tokens. Comments explicitly state "never tokens, Clerk sessions, credentials or a claim of current authorization."

- **Bearer redaction in evidence** (`controlled-read-live-capture.mjs:359-398`): `privateBytes()` recursively scans JSON for bearer string inclusion and JWT patterns. Rejects fields matching `/authorization|cookie|secret|password|api[_-]?key|session/iu`. Token fields constrained to numeric counts or `{status,reason,value}` observations.

- **Session hash only** (`run-controlled-read.mjs:353`): SHA256 of session ID stored, not the ID itself.

- **Environment scrubbing** (`run-controlled-read.mjs:170-172`): `CLERK_SECRET_KEY` deleted from env immediately after capture.

- **Safe output flags** (`materialize-controlled-read.mjs:54`): Files written with `{flag:'wx', mode:0o600}` - exclusive creation, owner-read-only.

**Verification:** Test at `tests/controlled-read-operator.test.mjs:666-667` verifies exclusive output and rejection of duplicate write attempts.

---

### 6. NO SIMULATED LIVE PROOF

**Correct separation of local vs live authority:**

- **Scope inspection is static** (`controlled-read-operator-input.mjs:230-233`):
```javascript
inspectControlledReadScope(
  { ...config, conversationId: config.captureRunId },
  { MERI_LIVE_BEARER_TOKEN: 'static-shape-inspection-only' },
);
```
  Uses placeholder token, actual config keeps `conversationId: null`.

- **Document disclaimer** (`CONTROLLED-READ-OPERATOR.md:69-70`): "This document and local input checks are not live proof. The collector requires fresh real AWS immutable build readback..."

- **Admission checks** in `controlled-read-live-capture.mjs` require actual HTTPS calls with real bearer, not mocked.

- **LIVE acceptance remains NOT_RUN**: All local stages emit `"liveAcceptance": "NOT_RUN"`; human adjudication required post-capture.

---

### 7. TEST COVERAGE

**Comprehensive unit tests** (`tests/controlled-read-operator.test.mjs`):

- Case 20/72 input chain preservation (lines 136-165)
- Rejection of other cases/tenants and stale plans (lines 166-184)
- Seed/reset receipt tampering detection (lines 185-200)
- Rate/budget qualification joins (lines 201-230)
- Synthetic Clerk identity validation (lines 231-261)
- Browser request filtering (lines 262-282)
- Conversation readback requirements (lines 283-310)
- Materializer CLI rejection of failed receipts and existing output (lines 311-348)

---

### MINOR OBSERVATION (Non-blocking)

None of the reviewed files contain actual backend route implementations or database mutations outside the controlled-read scope. The operator correctly delegates to existing API scripts (`meri-controlled-read-setup.mjs`, `meri-capture-provider-budget.mjs`) which have been separately reviewed per task description.

The `case01-build-authority.mjs` dependency in the operator runner (`run-controlled-read.mjs:19`) properly reuses existing build verification infrastructure without new authority surface.

---

## Final Verdict: PASS ✓

The five reviewed files (`controlled-read-operator-input.mjs`, `materialize-controlled-read.mjs`, `run-controlled-read.mjs`, `tests/controlled-read-operator.test.mjs`, `CONTROLLED-READ-OPERATOR.md`) demonstrate:

| Criterion | Status |
|-----------|--------|
| Trust boundaries with exact SHA joins | ✓ PASS |
| One-shot non-retry conversation creation | ✓ PASS |
| Temporary Clerk lifecycle (120s ticket, revocation) | ✓ PASS |
| Bounded HTTPS/build/source verification | ✓ PASS |
| No secret leaks (bearer redaction, session hash) | ✓ PASS |
| No simulated live proof | ✓ PASS |
| Test coverage for mutation/join cases | ✓ PASS |

The implementation correctly restricts to synthetic T1 Pat, cases 20/72 only, with frozen source definitions and immutable receipt chains. Materialized configs keep `conversationId: null` until actual authenticated POST+GET readback. No backend changes required for these operator-only files.