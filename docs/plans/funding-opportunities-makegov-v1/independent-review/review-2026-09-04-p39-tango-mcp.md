# Independent review — P39 Research-only Tango MCP connector (Band A, §6.2 wave)

**Status: COMPLETE (2026-09-04). Verdict in section 8; approval record in section 9.**

| | |
|---|---|
| Phase | P39 — Research-only Tango MCP connector |
| Band | A (one reviewer) |
| Pinned SHA (`origin/main`) | `1c7ed27fa82e171b7d9259f6c94d49e360cae985` |
| Implementer branch (claims) | `origin/agent/fo-p39-tango-mcp` @ `cf1731237` (PR #810) |
| Worktree | `C:\dev\capiro-review-p39` (clean at start; verified `git status --short` empty) |
| Reviewer | Claude, general-purpose subagent (runtime reports model `claude-fable-5-1`). Did **not** implement P39, PR #810, or any Meri MCP code. Third attempt at this review; two prior attempts produced no document. |
| Date | 2026-09-04 |
| Convention | `docs/runbooks/phase-2-independent-live-validation.md` — read-only, different reviewer, two-string verdict, dated approval record |

## 1. Scope and method

Questions the brief asked, restated as testable claims:

- C1 Read-only: no tool exposed to the model through this connector can write, mutate, spend paid tier, or leak the key.
- C2 Gating: the tool surface is tenant-scoped and gated by `funding_opportunities_tango_mcp` the way the HTTP routes are (cf. PR #1100 `agency_forecast` ungated bug).
- C3 P18 rate-limit / usage accounting is honoured on this path.
- C4 The catalog/parity spec pins the tool list (five tools: `resolve`, `search`, `search_opportunities`, `get_details`, `fetch_api_docs`).
- C5 Is there ANY live-verifiable success assertion for this phase?

Trusted: the code at the pin, the jest specs I ran myself, `git diff` of the implementer branch. **Not trusted** (treated as claims): completion-matrix row P39, PR #810 body, plan prose, comments in code.

## 2. Files changed by the implementer (from `git diff --stat e4fb4aa9d cf1731237`)

```
.github/workflows/funding-opportunities-ci.yml     |  43 ++++-
apps/api/src/funding-opportunities/__fixtures__/baseline-contract-v1.json |   7 +-
apps/api/src/meri/meri-mcp-transport.spec.ts       |  71 +++++++-
apps/api/src/meri/meri-mcp-transport.ts            |  46 ++++-
apps/api/src/meri/meri-mcp.catalog.spec.ts         | 200 +++++++++++++++++++++
apps/api/src/meri/meri-mcp.catalog.ts              | 126 +++++++++++++
apps/api/src/meri/meri-mcp.service.ts              |  74 +++++++-
```

Note: `apps/api/src/external/tango/**` was NOT touched by P39 — the MCP connector lives entirely in `apps/api/src/meri/`.

## 3. Correcting the brief's premises

Four premises in the review brief are wrong or stale at the pin; each is corrected before it can distort a finding.

1. **`apps/api/src/external/tango/**` and `meri-tools.service.ts` are not P39 code.** `git diff --stat e4fb4aa9d cf1731237` touches seven files: five in `apps/api/src/meri/`, the CI workflow, and the baseline fixture. The MCP connector never enters `external/tango/`; it rides the generic Meri MCP plumbing (`clio_mcp_servers`, `StreamableHTTPClientTransport`).
2. **The plan never required P18 accounting on this path.** P39's section (plan line 2434ff.) says only "Circuit breaker, audit, size cap, and untrusted-result wrapper remain" — the *Meri MCP* controls, not `tango-rate-limit.ts`. The brief's C3 is therefore answered "no, and the plan did not ask for it" — the consequence is still recorded as F-04 because it is real regardless of who asked.
3. **Completion-matrix row P39 says "not yet deployed to capiro-dev". That is stale.** The live `capiro-dev-api` service runs task definition `:281`, image tag `f2746744d…` pushed 2026-09-04T05:13-04:00, and `cf1731237` is an ancestor of the review pin (`git merge-base --is-ancestor cf1731237 HEAD` → true). P39's code is deployed; it is *flag-dark*, which is a different fact (see F-08).
4. **The "parity spec" that pins the tool list is `meri-mcp.catalog.spec.ts`, not the baseline fixture.** `baseline-contract-v1.json` carries only prose for P39 plus the suite/test counts (66/2095 → 68/2120); the five tool names are asserted at `apps/api/src/meri/meri-mcp.catalog.spec.ts:92-100`.

## 4. What I verified myself (reproducible transcript)

All commands run 2026-09-04 from `C:\dev\capiro-review-p39` at `1c7ed27fa`, or against live `capiro-dev` read-only.

```
$ git rev-parse HEAD                      -> 1c7ed27fa82e171b7d9259f6c94d49e360cae985
$ git status --short | wc -l              -> 0
$ git merge-base --is-ancestor cf1731237 HEAD && echo yes   -> yes

$ pnpm --filter @capiro/api exec jest src/meri/meri-mcp.catalog.spec.ts src/meri/meri-mcp-transport.spec.ts --forceExit
  PASS src/meri/meri-mcp.catalog.spec.ts (12.9 s)
  PASS src/meri/meri-mcp-transport.spec.ts (18.5 s)
  Tests: 27 passed, 27 total          (jest does not typecheck; this is behaviour only)

# Live vendor endpoint, NO credential of any kind sent:
$ curl -X POST https://govcon.dev/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
  HTTP/1.1 401 Unauthorized
  www-authenticate: Bearer resource_metadata="https://govcon.dev/.well-known/oauth-protected-resource"
  {"error":"Authentication required"}
$ curl https://govcon.dev/.well-known/oauth-protected-resource
  {"resource":"https://govcon.dev/mcp","authorization_servers":["https://tango.makegov.com"],"scopes_supported":["read"]}   (HTTP 200)
$ curl https://govcon.dev/.well-known/oauth-authorization-server     -> HTTP 200
$ curl -L https://govcon.dev/docs                                    -> HTTP 403 (docs not anonymously readable; header name unconfirmable from docs)

# Live task definition (read-only describe):
$ aws ecs describe-services --cluster capiro-dev --services capiro-dev-api -> capiro-dev-api:281
$ aws ecs describe-task-definition capiro-dev-api:281
    image  = .../capiro/dev/api@sha256:5c4a1c17...   (ECR: tag f2746744d274d3b6a161436f2da19fd5a2ae1e20, pushed 2026-09-04T05:13:33-04:00)
    env    : CLIO_MCP_OAUTH_REDIRECT_URI only -- CLIO_MCP_ENABLED is UNSET
    secret : OAUTH_TOKEN_ENCRYPTION_KEY (name only; value never read)
$ grep -n CLIO_MCP_ENABLED -A3 apps/api/src/config/config.schema.ts   -> .default('true')   => MCP tools are globally ON live

# Live DB, read-only diag task (capiro-dev-api-diag:8, node -e, one $transaction, bypass_rls, SELECTs only)
  task 817c800976bc4ce794405b1bd9ec60d7 -> exit 0
  DIAG_OK {
    "tables":[clio_mcp_oauth_credentials, clio_mcp_servers],
    "flags":[]                                   <- ZERO funding_opportunities_tango_mcp rows (any tenant, on or off)
    "flagCountAll": every other funding_opportunities* flag has n=7 rows (7 tenants)
    "servers":[ {catalog_id:"chrome", scope:user, n:1}, {catalog_id:"meriv3-airtable", scope:user, auth:oauth, n:1} ]
                                                 <- ZERO rows with catalog_id='makegov-tango'
  }
  (A first attempt, task d83d91a0..., failed on `column f.updated_at does not exist` -- intel_feature_flag has no such column; rerun without it. Both tasks STOPPED; nothing written.)

# Deployed-image lineage (git, after `git fetch origin main` in the worktree):
$ git merge-base --is-ancestor cf1731237 f2746744d274d3b6a161436f2da19fd5a2ae1e20 && echo yes   -> yes  (P39 IS in the deployed image)
$ git merge-base --is-ancestor 1c7ed27fa f2746744d274d3b6a161436f2da19fd5a2ae1e20 && echo yes   -> no   (the review pin is NEWER than the deployed build; irrelevant to P39, whose code has not changed since cf1731237)

# Live log evidence that the connector was never exercised:
#  (a) Two Logs Insights dumps left in the scratchpad by the earlier dead attempts (windows 2026-08-07..09-01 and 09-02..09-04,
#      3.6 MB total; their query filter is unknown so this is WEAK corroboration only): 0 lines matching any of
#      makegov-tango / X-Tango / govcon.dev / "MCP catalog feature read failed" / "MCP listTools failed" / clio.mcp_tool.call.
#  (b) My own `aws logs filter-log-events` sweep of /capiro/dev/api, 14-day window, same five patterns: 
#      14-day window, pattern [makegov-tango] -> 0 events
#      14-day window, pattern [MCP catalog feature read failed] -> 0 events
#      14-day window, pattern [X-Tango] -> 0 events
#      14-day window, pattern [govcon.dev] -> 0 events
#      14-day window, pattern [MCP listTools failed] -> 0 events
#      3-day window, combined ?makegov-tango ?X-Tango ?govcon.dev ?"MCP catalog feature read failed", --limit 20 -> 0 events
#      (all five 14-day queries completed before this document was finalized; the DB rows remain the decisive evidence)
#  The DB facts above (zero flag rows, zero connector rows) are the load-bearing evidence; the logs can only corroborate them.
```

I did **not** send, read, or log any Tango/MakeGov key, did not create the flag row, did not connect the connector, and did not start a Postgres container (none was needed).

## 5. Findings

Severity scale: High = the phase's stated safety/acceptance property is false at the pin; Medium = a real gap the plan or brief cares about, not currently exploitable live because the connector is dark; Low = informational or self-harm-only.

### F-01 (High) -- "Read-only" is a seed default, not an enforced property. Nothing at runtime pins the `makegov-tango` connector to the five tools or to read-only.

Evidence at the pin:
- `apps/api/src/meri/meri-mcp.catalog.ts:306-322` -- the five tools carry `readOnly: true` as *catalog metadata*; the field's own doc (`:128`) says suggested tools are "seeded into the allowlist".
- `apps/api/src/meri/meri-mcp.service.ts:297-299` (`createServer`) -- copies `suggestedTools` into the row's `toolAllowlist`/`readOnlyTools` **once**, at creation.
- `apps/api/src/meri/meri-mcp.service.ts:802-807` (`updateServer`) -- `toolAllowlist` and `readOnlyTools` are tenant-editable: `asStringArray(input.toolAllowlist).slice(0, 50)`, any string, no check against the catalog entry for a `catalogId` row.
- `apps/api/src/meri/meri-mcp.service.ts:474-499` (`registryFor`) -- bridges `filterAllowedMcpTools(await client.listTools(), allowlist)`; whatever the *server* exposes intersected with the *row's* allowlist reaches Meri. `readOnly` is `readOnly.has(tool.name)` from the row.
- `grep -rn readOnlyHint apps/api/src/meri/meri-mcp*.ts` -> no matches: the server's own MCP `annotations.readOnlyHint` is never consulted.

Consequence: if the real Tango MCP server exposes any mutating tool (P17 proved the vendor SDK has webhook-write and API-key-list methods; whether MCP surfaces them is unknown -- the tool list is unverified, see F-06), a tenant admin can add it to the allowlist and Meri will call it. The model cannot edit the allowlist itself, so the LLM-to-vendor boundary holds *by default*; but the phase's central promise ("All tools are read-only", plan acceptance) is a configuration state, not code. A catalog-pinned invariant (a `catalogId` row's allowlist must be a subset of the entry's `suggestedTools`, or refusing `readOnlyTools` edits for flagged entries) would close this in one guard.

### F-02 (High) -- "All tools are read-only **and audited**" is false for this connector: read-only tools are precisely the ones that skip the call audit.

Evidence: `apps/api/src/meri/meri-mcp.service.ts:556-562`
```ts
if (!entry.readOnly) {
  await this.audit(ctx, 'clio.mcp_tool.call', server.id, { server: server.name, tool: entry.toolName, argKeys: ... });
}
```
All five Tango tools are seeded `readOnly` (F-01), so **every** `resolve`/`search`/`search_opportunities`/`get_details`/`fetch_api_docs` call made on the firm's behalf to an external vendor produces no audit row and no success-path log line (the only writes on success are `breaker.recordSuccess` and, at registry refresh, `lastSyncAt`). The only audit rows are `clio.mcp_server.create`/`update`. This is inherited generic-MCP behaviour (P39's diff does not touch `executeBridgedTool`), but P39's own acceptance claims "audited" and the baseline prose repeats it. Combined with F-01: a tool wrongly marked read-only is both allowed and invisible.

### F-03 (Medium) -- The feature flag gates *offering* the connector, not *using* it. Same class as the PR #1100 `agency_forecast` bug, here by documented design.

Evidence: the flag (`requiresFeature`) is consulted in exactly two places -- `catalog()` via `visibleCatalogEntries` (`meri-mcp.service.ts:129-166`) and `createServer` (`:247-252`, refuses with the unknown-id sentence). `registryFor` (`:471`) filters only on `{ enabled: true }`; `executeBridgedTool` (`:549-553`) likewise. The doc comment at `:139-143` states it: "the flag governs OFFERING one, not orphaning one", and an already-connected entry stays visible "whatever the flag says".

Consequence: once one internal-tenant admin connects it, flipping `funding_opportunities_tango_mcp` off does **not** stop Meri calling govcon.dev -- someone must also set `enabled=false` on each row. The plan's rollback ("Disable/delete connector **and** flag") is consistent with that, but every Funding Opportunities HTTP route flag is an immediate 404, so operators will expect the flag alone to be the kill switch -- the expectation PR #1100 corrected for `agency_forecast`. Currently unexploitable live (zero rows, F-08).

### F-04 (Medium) -- P18 rate-limit / usage / ceiling / EMF accounting is not on this path, and the shared-key case makes that matter.

Evidence: `grep -n "external/tango\|resilience\|rateLimit" apps/api/src/meri/meri-mcp*.ts` -> nothing. The transport (`meri-mcp-transport.ts:93-101`) hands the token to `StreamableHTTPClientTransport` directly; no 429 `wait_in_seconds` handling, no per-run/per-day ceiling, no `tango_*` usage counters, no EMF. P39's plan section did not require it (premise 2 above). But the plan's ship note is "Connect only for internal tenant", and the internal tenant is the one tenant able to paste the *production* MakeGov key; if it does, every Meri research call draws down the same vendor quota that P18 meters for scheduled syncs, invisibly to P18's ceilings and health diagnostic. The catalog's `setupNote` ("Use a key dedicated to research", `meri-mcp.catalog.ts:304-305`) is the only mitigation and it is advice.

### F-05 (Medium) -- Zero test coverage of the flag gate and of the header wiring into the live client.

Evidence: `ls apps/api/src/meri/ | grep mcp` shows no `meri-mcp.service.spec.ts` at the pin. The 27 passing tests exercise catalog **data** (`meri-mcp.catalog.spec.ts`) and the pure function `tokenHeaderFor` (`meri-mcp-transport.spec.ts`). Untested: `visibleCatalogEntries` hide-when-off / show-when-connected, `createServer` refusal with the identical sentence, `featureEnabled` fail-closed on a throwing read, and `clientFor` passing `catalogTokenHeader(server.catalogId)` (`meri-mcp.service.ts:643-648`) -- the one line that makes the header allowlist apply to a real row. Plan acceptance items "Disabled connector has no tool registrations" and "A dead MCP server degrades the turn but not local tools" are satisfied by pre-existing code (`registryFor` `enabled:true` filter; per-server try/catch at `:507`; `bridgedSchemasFor` catch -> `[]` at `:455-460`) that P39 added no test for.

### F-06 (Medium) -- The auth model shipped is the one the live server does not advertise; endpoint existence is now confirmed, header acceptance is not.

Evidence (live, no credential): `POST https://govcon.dev/mcp` -> **401** with `WWW-Authenticate: Bearer resource_metadata="https://govcon.dev/.well-known/oauth-protected-resource"`; that document lists `authorization_servers: ["https://tango.makegov.com"]`, `scopes_supported: ["read"]`; `/.well-known/oauth-authorization-server` -> 200.

So: (a) the endpoint is real -- a 401, not a 404 -- which is the program's first live evidence on this point (the matrix row and the 2026-08-07 decision entry say "unconfirmed"); (b) the server advertises **OAuth 2.1 Bearer with a `read` scope**, which is exactly the server-side read-only guarantee F-01 lacks; (c) the catalog ships `authType: 'token'` + `tokenHeader: 'X-Tango-API-Key'` (`meri-mcp.catalog.ts:294-299`), a path the server does not advertise. The plan explicitly offered "Alternatively use reviewed OAuth if P17 proves it is operational". Whether `X-Tango-API-Key` is *also* accepted cannot be known without sending a key, which this review does not do. If it is not, the code's own comment (`meri-mcp-transport.ts:52-55`) predicts the failure mode: it "looks like a bad key". `govcon.dev/docs` returns 403 to an anonymous fetch, so the header name cannot be confirmed from documentation either.

### F-07 (Low) -- Key handling is sound; one self-harm-only edge.

Positive: the token is AES-enveloped at rest (`encryptSecret`, `meri-mcp.service.ts:810-814`), decrypted only inside `clientFor`, and emitted only via `tokenHeaderFor`, whose sweep test proves no header outside `{Authorization, X-Tango-API-Key}` can be produced from any input; `catalogTokenHeader` reads the header from the catalog by `catalogId`, never from the row (`:643-648`). Error paths persist `lastError = message.slice(0,500)` and `logger.warn` the SDK message (`:507-509`) -- SDK errors carry status/body, not request headers; no key-leak path found. `catalog()` returns the header *name*, not a secret.

Edge: `updateServer` lets a tenant admin change `endpoint` on a catalog-linked row (`:788-791`, SSRF guard only). The row keeps `catalogId='makegov-tango'`, so the decrypted key would be sent as `X-Tango-API-Key` to any HTTPS host that admin chooses. It is the same admin who pasted the key, so this is self-harm only; noted because the design comment's threat ("aim a decrypted secret at an arbitrary header on an arbitrary endpoint") is closed for the header but half-open for the endpoint.

### F-08 (Low, informational) -- Live posture: deployed, globally enabled, and never offered to anyone.

- Code: deployed (task def `:281`, image built 2026-09-04; `cf1731237` in the pin's ancestry).
- Global switch: `CLIO_MCP_ENABLED` unset -> default `true` -- Meri MCP is live for the two existing connectors (`chrome`, `meriv3-airtable`).
- P39 flag: **zero** `intel_feature_flag` rows for `funding_opportunities_tango_mcp` across 7 tenants (all ten other `funding_opportunities*` flags have exactly 7 rows). The connector is hidden from every catalog response and `createServer` would refuse it for every tenant.
- Connections: **zero** `clio_mcp_servers` rows with `catalog_id='makegov-tango'`.
- Matrix row P39 "not yet deployed to capiro-dev" should read "deployed flag-dark; no flag row, no connection".

## 6. The explicit answer: does P39 have any live-verifiable success assertion?

**No.** The phase's own evidence is 27 unit tests over static catalog data and one pure function; the implementer's baseline prose says so ("NOT VERIFIED LIVE ... a live handshake is a canary step, not a merge gate") and the matrix repeats it. There is no smoke, no `diag-*` entry, no canary step in `funding-opportunities-makegov-canary.md` that would produce a pass/fail for "Meri listed the five Tango tools and `search` returned a result".

This review adds the first live *facts* -- the endpoint exists (401), it advertises OAuth Bearer/`read`, the code is deployed, the flag is dark with zero rows -- but none of those is a success assertion for the connector working. A success assertion would require sending a key, which is (correctly) outside a read-only reviewer's remit. The first person to flip the flag for the internal tenant and connect will be the first person to learn whether `X-Tango-API-Key` is accepted and whether the five tool names exist.

## 7. What passes

- The header allowlist is genuinely closed, catalog-owned, re-validated at the transport, and well-tested (13 targeted tests); an arbitrary custom connector cannot choose a sensitive header. Plan acceptance items 1-2 hold.
- The key never appears in DB plaintext or in any log path I could find. Plan acceptance item 6 holds as far as static analysis can show.
- Flag-off hides the entry and refuses connection with the same sentence an unknown id gets, failing closed on a broken read -- the right shape, just untested (F-05) and offer-time only (F-03).
- `meri-mcp.catalog.spec.ts:140-170` proves by source scan that the deterministic Funding Opportunities code (engine, service, inbox, landscape, action plan, both Meri adapters) cannot reach `meri-mcp`/`callTool` -- the plan's "Never expose this connector to deterministic scoring, alerts, or automatic artifact generation" holds.
- Circuit breaker, 8000-char result cap, `untrusted: true` wrapper, and per-server failure isolation remain (pre-existing, unchanged).
- Live risk today is nil: nobody can see, connect, or call the connector.

## 8. Verdict

**`FAIL` -- `P39_TANGO_MCP_REJECTED`**

Reason: two of the plan's six acceptance criteria are false at the pin for this connector -- "All tools are read-only" is an editable default with no code invariant (F-01), and "and audited" is inverted (read-only tools are the unaudited ones, F-02). The brief's trust-boundary question ("can any tool exposed to the model write...") is answered *not by default, and nothing prevents it*. Mediums F-03/F-04/F-06 are real but unexploitable while dark. The header work -- the part the implementer spent the tests on -- is good and is not why this fails.

Smallest path to a re-review PASS: (1) a guard that a `catalogId` row's `toolAllowlist` is a subset of its catalog `suggestedTools` and that flagged entries' `readOnlyTools` are not tenant-editable; (2) audit `clio.mcp_tool.call` for every call on a `requiresFeature` connector regardless of `readOnly`; (3) re-check `requiresFeature` in `registryFor` (or at minimum state in the canary runbook that the flag is not the kill switch); (4) a `meri-mcp.service.spec.ts` covering F-05's four untested paths; (5) decide OAuth-vs-API-key against the live server's advertised metadata before the first internal-tenant connection.

## 9. Approval record

| Field | Value |
|---|---|
| Phase | P39 -- Research-only Tango MCP connector |
| Pinned SHA | `1c7ed27fa82e171b7d9259f6c94d49e360cae985` (`origin/main`) |
| Implementer commit reviewed against | `cf1731237` (PR #810), ancestor of pin |
| Reviewer | Claude, general-purpose subagent, runtime model `claude-fable-5-1`; did not implement P39 or PR #810 |
| Verdict | `FAIL` -- `P39_TANGO_MCP_REJECTED` |
| Date | 2026-09-04 |
| Live writes performed | none (two read-only diag tasks, SELECT-only inside `set_config('app.bypass_rls','on',true)` transactions; both STOPPED) |
| Secrets touched | none (task-def secret *names* listed; no value read; no vendor key sent) |
| Worktree state at close | see section 10 |

## 10. Cleanup attestation

- `git -C C:/dev/capiro-review-p39 rev-parse HEAD` -> `1c7ed27fa82e171b7d9259f6c94d49e360cae985` (unchanged).
- `git status --short --untracked-files=all | wc -l` -> `0`. No probe file was ever written inside the worktree; the diag JS and override JSON lived in the session scratchpad and are deleted.
- No Postgres container was created (`docker ps -a --filter name=capiro-p39-review-pg` -> empty); the live diag task made a disposable one unnecessary.
- Two Fargate diag tasks (`d83d91a0...`, `817c8009...`) ran and STOPPED; no other AWS task launched; no `put-*`/`enable`/`disable`/`update-*` call issued.
- Only `git fetch origin main` and `git fetch origin agent/fo-p39-tango-mcp` touched the worktree's object store (refs only; checkout untouched).
