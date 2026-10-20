# Existing saved Directory target Objective observation

This source candidate extends the existing ClientTargetsController and ClientTargetsService. Its eligible resource is one current saved ClientTarget row. It creates no Objective association, target, entity, content, command or receipt store; it does not query Directory/S3, enrich metadata, generate content or send anything.

Source checkpoint: `53dc10fad8eb9f2bfc77b0ddc28a7c6f29a06fc0`, tree `cd5ad937d360412952687e39da686528129d5bbe`. Independent review accepts that exact source and the frozen84-case packet `e6497fbce916b565b9c42b0763c9ae339bd0fa35`/`9a616d85e9aedfe615cd9316c9ed907586bb49ce`; see INDEPENDENT-REVIEW.md/json. Preserved83-case source: `36ba0b9e236c2fa3162d01803289f52ca375b3ae`, tree `ef02515a2ec71230288787336e51fea00e9f6a1d`, packet `cd434db1c21695b75de6b65181a9b01bab4c82eb`. Initial preserved candidate: `bdefa6269fef468d802ab324a971273959e6f572`, tree `dc509dd07c360c515776baaa331f81fc8ccce143`. Original base: published Layout PR10 `be12f4a2a2ecec43b5d02ea279d9448763415e24`, tree `657902eb63067e1d44e02c908552dd7d93c85170`. All original heads and passing/failed evidence remain retained.

The authorized ordinary receive is complete. Published root-owned Meetings corrective draft [PR12](https://github.com/neo-capiro/capiro-backend/pull/12), head `2090c6afb26795edcfb73c46b9f3add3512ecdd8`/tree `fcca666d5a0e4923ba3493d446a28dfbaacb0ba2`, includes published legacy syntax PR11 `cc0cfaafe6f83c544b47c6e01559f29dc0953b84`/`bc8c013a36aee1ba0b3974f63ea9b5a15570fc39`. The preserved Directory packet parent `507a789238bf9b594d93401e53a3ad73f45e4160` and that exact PR12 head are the two parents of source union `d60cdc08a824f94dcdb6336dd2e62a3746a27539`/`730ad143f26cc64f2f154dc7cfad64d1fae8c7c3`. MERGE-RECEIPT.json and the independent union checkpoint prove zero overlapping paths and every tree tuple equals the selected original parent/base value. All59 checked Git source blobs,50 tracked configuration inputs and1582 cached declaration hashes remain exact, so no repeated tests are required. Final packet-only changes add the handoff/proof/review seal; they add no product source or runtime qualification. Draft publication targets the existing PR12 branch `codex/backend-meetings-bundle-reuse-20261014`; no main merge or deployment is authorized.

Final independent review accepts frozen packet `74ef5ee9ee37efbbe3894f82421d766457ba4643`/`c2c0f62dc57a08f1292e3913da5fa180ce1caabb`, including the exact27811-tree-tuple union,59 sealed payloads/17 lossless raw observations, unchanged checked bindings and truthful runtime/frontend limits. FINAL-INDEPENDENT-ACCEPTANCE.md and FINAL-INDEPENDENT-REVIEW.json are copied byte-exact from the reviewer; the subsequent append consists only of those review documents, two precisely recorded harmless reviewer path-read errors, this handoff and the updated hash index. The reviewer did not mutate source or execute tests. The read errors are not product or test failures. No product-source or checked-input change follows the accepted packet.

## Exact owner transport and receiving schema

```text
GET /api/clients/:clientId/targets/:targetId/objective-destination
  ?clientId=<same UUID>&objectiveId=<UUID>&objectiveVersion=<positive int32>
```

Path client and target IDs are UUIDs. The query is the existing strict ObjectiveDestinationQueryDto: exactly clientId, objectiveId and objectiveVersion (1..2147483647). UUID case is normalized. Path and query client must match; mismatch is400 before database access. No tenant, actor, URL, resource kind, member ID, revision ID or cached labels can supply authority.

Success is exactly:

```json
{
  "destination": {
    "kind": "directory_target",
    "resourceId": "<current saved ClientTarget UUID>",
    "clientId": "<canonical client UUID>",
    "objectiveId": "<current saved Objective UUID>",
    "objectiveVersion": 3,
    "objectiveRevisionId": "<existing immutable Objective revision UUID>"
  },
  "target": {
    "id": "<same saved ClientTarget UUID>",
    "clientId": "<same client UUID>",
    "sourceDirectory": "congress",
    "memberId": "<exact bounded stored identity>"
  }
}
```

sourceDirectory is exactly congress/state/staff; memberId is a nonblank stored string of at most128 Unicode characters under the existing AddTargetDto/class-validator MaxLength rule, not a UTF16-unit budget. This preserves the existing target owner’s bounded opaque identity semantics; it does not guess a stricter member/staff/OpenStates grammar. Existing id-only targets remain eligible saved rows even when no current Directory entity can be resolved. The payload contains no label, directory details, arbitrary metadata, URL, immutable target-version claim or cache-provenance claim. A resourceId here is the saved target UUID, not the global entity’s string ID or a Directory snapshot UUID. `Cache-Control: private, no-store`.

Malformed query/path is400. Missing/foreign/moved/deleted target, unsupported stored identity, archived/missing client, revoked/current-unavailable tenant/member/Clerk mapping/wall/Objective/revision is404 without foreign metadata. Only an otherwise authorized current saved target exposes409 `OBJECTIVE_VERSION_CONFLICT`. Infrastructure errors propagate; they are not converted to404/conflict, cached success or automatic retry.

## Canonical authority, locks and replay

The existing withTenantUser transaction binds the server’s tenant/native UUID actor. The byte-unchanged shared Objective helper `767a11ddff2ff43a39cdf572029b40a4976facac` runs first on that SAME transaction: active tenant/current membership and exact Clerk/native mapping, internal role floor, nonarchived client and actual wall grant, current nondeleted Objective/version, existing immutable revision. Admin status and target assignment grant no bypass. Draft/In-review/Ready Objective state follows the existing helper; no new readiness gate.

Client authority SHARE locks precede the exact saved-target SELECT FOR SHARE, matching the parent-client/cascade-before-child order. Only the helper’s typed OBJECTIVE_VERSION_CONFLICT is temporarily deferred. Any other unavailable scope or infrastructure error exits immediately. Within the same transaction the exact target is read under explicit tenant/client/target predicates and validated; unavailable target returns404 even if a stale Objective conflict was deferred. An eligible target then returns the unchanged typed conflict or successful binding.

Existing tier UPDATE and target DELETE use PostgreSQL’s row write locks; removal, mutation and parent cascade conflict with this target SHARE read. No target writer, schema, shared helper, wall writer, tenant middleware, Clerk source, role guard, existing constructor or module registration changes. Joined authority-row lock acquisition, native RLS/permissions/MVCC, revocation and client/grant/cascade availability remain unqualified. Source and synthetic SQL schedules are not native proof.

Each reopen/retry must resolve again; previous receipts are observations, not bearer capabilities or durable associations. Repeated resolution rechecks current authority and target identity and returns no automatic fallback. A change after the transaction can invalidate an observation.

## Real mount, configuration and frontend boundary

ClientTargetsController and ClientTargetsService already belong to ClientsModule. Core AppModule already imports it; Core main/configureApiHttpApp mounts /api (API_PORT default4000). The fixed frontend binding remains CORE_API_BASE_URL. No new controller family, process, service, store, auth or preview layer is introduced.

At exact frontend `98c6eefea0953fbecccd88de43161c6bc809f300`, /modules/directory reads only view: congressional-staff, committee-staff, department-of-war, state-legislators, state-committees. CongressionalContacts selects a profile in local React state; StateDirectory lists records/official links. There is no saved-target UUID/member/staff/state exact reopen selector or Objective-bound reader there. This source closes the backend saved-target observation seam only; frontend owner must add a reviewed fixed operation/receipt and exact reopen composition, including session/client replacement/history/retry re-resolution. Do not invent a supported deep URL, treat saved metadata as canonical current Directory details or fall back to generic unbound browsing after a failed bound resolve.

## One dependency and overlap matrix

| Scope | Exact source/dependency | Ownership and disposition |
| --- | --- | --- |
| Existing Objective persistence | PR2362 72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e; existing shared helper767a11d | Reused without DDL/service/store. Existing Objective migration/native release prerequisite remains. |
| Selected Directory resource | PR2400 6c26ac2dad3756a61b6733329dea7ce3c9138ece docs/portfolio-backend-20261012/REMAINING-CONTRACTS.md lines128–144; existing ClientTarget | Plan names directory_target with supported exact kind/ID. This GET observes existing same-client saved resource; no durable association writer inferred. |
| Original reviewed Directory source base | PR10 be12f4a2a2ecec43b5d02ea279d9448763415e24 | Source delta exactly4paths: existing targets controller/service and2new focused tests. Layout/prospect/schema/auth code unchanged. |
| Final operational receiving base | Published PR12 2090c6afb26795edcfb73c46b9f3add3512ecdd8, including PR11 cc0cfaafe6f83c544b47c6e01559f29dc0953b84 | Ordinary receive d60cdc08a824f94dcdb6336dd2e62a3746a27539 is the exact disjoint union. The parent-owned corrected Meetings runtime and legacy syntax changes are preserved without edits; all checked Directory inputs remain unchanged. |
| Directory frontend | Frontend98c6ee request OBJECTIVE-CONTRACT-NEEDS.md and exact Directory files | Current module/view exists; exact resource reopen remains frontend receiving work. No generic navigation/source-complete UI claim. |
| Context files / Calendar | Exact audit at docs/sdk-015-review-20261014/OBJECTIVE-CONTRACT-NEEDS.md; primary ledger797e3a and PR2400 | Existing Workspace immutable revision owner already supports current same-client observation. Attachment/version-versus-Workspace and Calendar exact source/occurrence presentation choices remain separately pending; no guessed writer or global Federal Rule client association. |

The preserved private receiving stack is PR6 authority `1f2655fe964cb2a01343d3bcb560de60fa5f69be` → PR7 flags `9b9f98d86aebe79721b3655e5a619b27be9a43e9` → PR8 original Core `afff08b0342985e3a8050a5fb4cd843741a720a5` → PR9 prospect `7239a4a4ace420492d8aace6c85e55773865be38` → PR10 Layout be12 → PR11 cc0 → PR12 2090 → this Directory draft. PR12 corrects the subsequent real Meetings duplicate-bundle regression in original PR8; original PR8 checks do not establish current whole-Core acceptance. Production capirov2 main remains outside this source publication. Directory, Layout, Prospect, legacy syntax and Meetings corrective source deltas are not mixed from incompatible candidates.

## Matching qualification and preserved attempts

Final source checkpoint84/84 tests across4suites; all26 exact baseline test identities/multiplicity retained, plus58 meaningful new controls. Baseline used exact Git service bytes at be12 (two observed overlay reads), without touching product source. New cases cover congress/state/staff saved identities, exact bound shape/no labels/provider lookup, canonical helper/query/lock order and native actor mapping, wall/admin/membership/tenant/client/revision refusal, replay/revocation, stale versus missing/moved/source-invalid target nondisclosure, late target-read infrastructure identity/no retry, bounded versions/member ID including the existing Unicode character budget, strict unknown/repeated/missing query and path mismatch, actual normal bearer/role refusal and membership change after native middleware login.

The native synthetic HTTP fixture registers the actual existing controller/service, ordinary RolesGuard and actual TenantContextMiddleware/TenantModule/private provenance with ONLY inert DB/Clerk IO ports; no listener. Its unchanged ClientsModule/Core registration is separately source-pinned. It does not boot all ClientsModule/Core providers. No full Core rerun is claimed. The independently reviewed parent Meetings correction is now received as PR12; its separate qualification does not expand this Directory fixture's scope.

Strict changed-entry VFS qualification passes with zero diagnostics:59 exact repository sources plus cached third-party/native Prisma declarations,1641 total source/declaration files. strict/noUncheckedIndexedAccess enabled; original API config plus workspace-source rootDir and DOM from Shared owner. Workspace packages bound to exact Git source. No protected EngagementService body in this closure. No native Prisma download/generation/engine/RLS/Postgres/migration/provider/live HTTP/default-worker/deployment acceptance.

Retained attempt evidence: sparse worktree initial no-checkout read miss before read-tree initialization; materializer first attempt rejected unsupported add --no-cone; corrected27source runtime closure; root-level @capiro/shared probe failed while API-scope owner resolution succeeded; exact base baseline26PASS; initial frozen source80PASS/typesPASS; intermediate83PASS/typesPASS. The observed owner Unicode-budget mismatch was corrected before final independent review. Two matching Jest launch attempts06/08 failed in Rust sandbox setup with ENOSPC before any test runner started; no test failure/result is fabricated. After root restored ordinary temporary capacity using only independently archived owner-confirmed obsolete bytes,09Jest84PASS and07strictPASS bind the Unicode-corrected source unchanged. They use this worktree’s own temporary directory/cache. All running-check stdout/stderr use lossless base64 containers with byte hashes; launch failures are separately precise structured observations. Completed own baseline Jest transform cache4828KB and completed83-case cache4,788,461bytes were removed only after preserving their outputs/receipts and source seal; no borrowed dependency, Git store, source or evidence object removed.
