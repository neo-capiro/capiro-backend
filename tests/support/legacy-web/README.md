# Retired main-Web qualification support

These files preserve backend qualification inputs and historical acceptance tools after current-tip retirement of `apps/web/src`. They are not an application workspace, a shared runtime authority, a current frontend source assertion, or deployed/browser acceptance.

`SOURCE-INPUTS.json` pins source commit `4e0c189c5d0522098be1c4916a033bb681d11c0b`, original paths, Git blobs, byte sizes and SHA-256 hashes for 13 relocated harness files and three source operands. Harness files retain the same directory depth and sibling imports. Their only byte changes are literal `apps/web/scripts/` to `tests/support/legacy-web/` path replacements; `inputs.spec.mjs` reconstructs every original byte with that exact inverse. Original Git history and the separate full source retirement manifest remain the recovery authority.

App and hearing transport operands are `.txt` qualification data. Backend CTA and Intel transport tests still compare their own inputs with the sealed source bytes. The generated preview-route table is qualification data: its drift check derives current backend route patterns and compares their rendering to this owned output. It establishes no current frontend routing or public authority. Changing route contracts requires an explicit table/provenance update.

Existing backend-owned manifests remain canonical at `apps/api/scripts/__fixtures__/engagement-current-ui-surface-manifest.v1.json` and `apps/api/src/engagement/__fixtures__/outreach-v3-ui-inventory-manifest.v1.json`. Engagement read materialization, external denial, resilience, evidence and inventory tests read those inputs. The skeleton contract remains at `apps/api/src/outreach-v3/state/__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt`. No whole UI source tree is copied here.

## Test identity accounting

| Original test | Current owner | Disposition |
| --- | --- | --- |
| `scripts/engagement-phase3-ui-inventory.spec.mjs` / `the committed manifest is exactly what the builder generates` | `historical-source-replay.spec.mjs` | Same name and builder equality assertion; explicit pinned full-source input required. |
| Same source / `output is deterministic across repeated builds` | `historical-source-replay.spec.mjs` | Same name and both builder calls/key-order assertions. |
| `apps/api/src/engagement/runtime/engagement-phase1-browser-acceptance.spec.ts` / `is absent from every file under apps/web/src` | `historical-source-replay.spec.mjs` | Same name, complete tree traversal and both shim-token checks. Jest equality becomes equivalent Node strict equality. All other API membership/harness cases remain. |
| CTA parity / `owned CTA route input matches the retained current frontend source` | Same file / `owned CTA route input matches the sealed retired frontend source` | Same byte equality against sealed source; current frontend conformance claim removed. |
| Intel parity / `Intel qualification preserves the retained frontend transport bytes` | Same file / `Intel qualification preserves the sealed retired frontend transport bytes` | Same byte equality against sealed source. |
| Planner / `backend excludes exactly original direct Web steps and only browser control argv` | Same planner spec / `backend excludes direct Web and historical UI main while retaining source controls` | Adds explicit assertions that backend argv retain prototype, scope/findings and scope-base pure controls; full step-array inverse remains byte-exact. |

The backend inventory suite retains all 30 other original cases and negative controls, adds two backend identity/purity cases, and removes four pre-existing scope-based skips because it validates immutable historical data. It has 32 backend cases. The separate replay suite has three relocated frontend cases. Missing replay input refuses collection; it is never skipped or counted as current frontend acceptance.

The parent's first integrated reader run exposed five inherited inventory assertion failures. Exact Git `4e0c189c` has the same `2f8a2cb0f733016078b2f9f54418f77962f1d069` blob at both the original Web and owned API inventory paths. Its 237 requests include 15 unmapped routes, 86 null surfaces, 26 scanner findings and two V3 consumer files; 15 retained backend routes have no inventory coverage. These assertions remain failing, and the backend inventory CLI emits `INVALID` and exits 1. Snapshot byte identity is not semantic acceptance. Negative controls now require a newly introduced matching diagnostic so inherited defects cannot falsely satisfy a mutation test.

Two CTA failures in that run were Windows checkout line endings: the owned fixture had 30,943 bytes/687 CRLF pairs instead of canonical Git's 30,256 bytes. Restoring exact Git blob `24d75b1bd4d3e22d4eb0027b9412b33281a84c85` reproduces SHA-256 `a7b1ff2a7cb9945af55ba58c5849cfe18cf5f89a47c195d99e7edac1fcbfe2cc`; assertions were unchanged. The root slice pins the fixture and archived operands to LF. No rerun is claimed here.

## Explicit historical replay

Supply an existing clean, read-only full-source checkout of exactly the pinned commit:

```powershell
$env:CAPIRO_LEGACY_WEB_SOURCE_ROOT = '<clean full-source checkout at 4e0c189c5d0522098be1c4916a033bb681d11c0b>'
node --test tests/support/legacy-web/historical-source-replay.spec.mjs
node scripts/verify-engagement-web-no-preview-header.mjs
```

Commands verify commit and source cleanliness before traversal. They do not create/extract a checkout, compile, install, start a browser/database, or modify historical source. Browser/local harnesses retain their original runtime/resource authorization and dependencies. Local mixed Engagement runners refuse missing Web source before creating disposable resources. Historical replay does not qualify the separately owned current frontend artifact.

## Backend scopes

Default aliases are owned by the root workspace slice. Explicit backend invocations:

- `node scripts/validate-knowledge-plane-phase26.mjs --run --backend-only`; fast adds `--skip-tests` and keeps its typing-only marker.
- `node scripts/verify-outreach-v3-phase2-code.mjs --run --backend-only` and Phase 5 equivalent. Every original backend step/assertion remains; completion marker declares backend scope.
- `node scripts/verify-outreach-v3-phase6-code.mjs --run --backend-only`: retains historical API/package/infra/migration boundaries, owned preview-pattern drift, and whitespace. UI source/build/browser obligations remain in full historical mode and are not reported as executed backend checks.
- `node scripts/verify-research-portfolios-phases1-4.mjs --backend-only`: retains all API/schema/migration/closeout checks; UI file/route checks remain in full historical mode.
- `node scripts/engagement-phase3-ui-inventory.mjs --backend-only`: validates exact owned inventory bytes and backend route/classification invariants; never rebuilds current UI inventory.

The historical `Phase 3 V3/prototype boundary` main stage is frontend-only because it unconditionally proves the two old v2 UI files still exist and forbids their retirement. Its original main assertions, full step-array identity and frontend selection remain. Backend control argv still run the pure prototype/source-inventory negative controls. `Phase 3 scope and findings` remains selected unchanged for backend: it enforces retained-range infra/migration/Compute policy, runtime-enablement bans and the open-P0/open-P1/blocking-P2 ledger. Both guard modules resolve their Git base only when `main` runs; importing their pure controls no longer reads Git or requires an `origin/main` ref.

## Validation handoff

No tests, compiler, install, browser, database or build ran in this implementation lane. Parent runs the focused Node batch and quick syntax checks after integration; heavy/native checks use the shared queue.

```text
node --test tests/support/legacy-web/inputs.spec.mjs scripts/lib/outreach-code-scope.spec.mjs apps/intel-api/src/tracker/email-cta-route-input-parity.spec.mjs apps/intel-api/test/qualification/hearing-recording-transport-parity.spec.mjs scripts/engagement-phase3-ui-inventory.spec.mjs scripts/engagement-phase3-qualification-plan.spec.mjs
```

The parent's integrated reader batch, including the two relocated pure browser modules, reported 117 cases: 110 passed and seven failed, with zero skips. Two were the CTA line-ending issue above; five were inherited inventory assertions. Preserve the actual native receipt and keep a reduced current-input batch separate from the explicitly failing historical inventory stage. Also run API `src/engagement/runtime/engagement-phase1-browser-acceptance.spec.ts` through its qualified runner when allocated. The historical replay suite is outside the backend total.

Full frontend tools such as Outreach Phase 6 final/maintenance/CSS generators and LegiWatch browser qualification remain historical commands requiring frontend source; they are not default backend acceptance. Global Cleanup/E2E source-identity obligations remain separately unqualified. Public assets/nginx and Onboard are retained by the root slice.
