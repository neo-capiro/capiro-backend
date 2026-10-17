# Objective → Strategy → Planner: final integration boundary

**Reviewed source through Core PR73; execution HOLD.** This index is for Core,
frontend and Fable. It establishes source compatibility, not a merged release,
deployed service, applied migration or live authorization.

## Immutable cohort and ancestry

- Core: [PR73 source](https://github.com/neo-capiro/capiro-backend/tree/fef07a45a7d1ec5e80ec1c4e80cd782a77261f36),
  tree `ab907464d88df5925c2b9f3dd3ae45618b6b0690`.
- Frontend: PR80 `de59687eb0067b19cc4ff2ffceddb19419ae9d8e` and
  [integrated PR82](https://github.com/neo-capiro/capiro-frontend/tree/36e6b70b9c086ba46bf24568865c50ba3a455ca9),
  tree `0d6e9fb3c3448950df5bd338b4d3802b7977975f`. PR82 is the PR78 integration
  with the Strategy intake delta; this is not a claim that PR82 descends PR80.
- Meri Objective: [sealed PR129](https://github.com/neo-capiro/meri-greenfield/blob/047526c7022d04af6fd0f8faaae011171ef1eca2/docs/objective-source-reader-v2-20261017/FABLE-BOUNDARY-SUPPLEMENT.md),
  `047526c7022d04af6fd0f8faaae011171ef1eca2`, separately held from
  [Fable's primary handoff](https://github.com/neo-capiro/meri-greenfield/blob/c7af4ed6389405c50a6621535a33fd253d5de7c4/docs/handover/20261017/fable-final/README.md).

Every Core pin below is an ancestor of PR73. Remote PR heads were read back at
these exact pins; all fifteen remained open drafts. This is an ordered selected
PR index, not a claim that every adjacent row is a direct parent.

| PR | Exact head |
| --- | --- |
| 42 | `6d24414da975b52ab9802a883b22c868ad14fc92` |
| 49 | `db6ef0a617f4b570cadfa6e05bad7296017d0f70` |
| 50 | `5591eac08428635bf911a0aa32acea859e2a5d95` |
| 51 | `81dd0313760c0f18858cb8aa2ad73191da71f138` |
| 53 | `57f8c8047a73df6d4a73351a98a5239f38240a24` |
| 56 | `bdcb546804f35d0973603fca5e99dbd4d640953f` |
| 57 | `b05918cb7d2c3368b01415e4c40d733e100ad361` |
| 58 | `151a2ec995b95817a2f4002a7cc3dba7899d06ee` |
| 60 | `88174160e2f6d1d7a9ee45a9f3f0eaa0d0671b4f` |
| 61 | `eef7cd1b874549bc2115b313ebb00fe83e2e57da` |
| 63 | `6c97e0f993ab47d5cc5c94b8021c985b0399ef8a` |
| 64 | `806a0939267806e7481bb2bbfe260f5a5a0794c3` |
| 66 | `49f328eb8fbf797a38e9a5dc3df254eb652daa39` |
| 70 | `7b39d341f2a5300f37b0a9aab4899fc3dab3ccf3` |
| 73 | `fef07a45a7d1ec5e80ec1c4e80cd782a77261f36` |

PR49 directly parents PR42. PR50 preserves the intervening continuation chain
`db6ef0a6 → b8b7262a → 7da0c2ca → a2b35fb6 → 3ebecd93 → a82e49b1 → 5591eac0`.
No reverted/parallel Objective implementation was found in the inspected chain:
one action router composes Planner/Strategy owners, one runtime supplies both v2
receivers, and shared materialization codecs retain thin existing wrappers.
V1 Strategy retry is replay-only; v2 owns fresh initial selection. Legacy job
claim/recovery/expiry/dispatch excludes canonical reservations, including
malformed reservation values. No Engagement implementation was added or removed.

## Source-mounted paths and gates

| Surface | Current source state |
| --- | --- |
| Core `/api/clients/:clientId/objectives/:objectiveId/generation` | GET base and `/outputs`; POST `/commands`, `/strategy-commands`, `/confirm-pair`. AppModule → ClientsModule → ObjectiveWorkModule is connected. Current native identity/client access remains required. |
| Core `/api/internal/objective-workload-authority/decisions` | PR73 main-only exact POST capture: original binary copy, 4096-byte limit, no compression, strict original content headers and duplicate Authorization rejection. Admission provider is still the zero-argument disabled factory. |
| Strategy `/strategy-api/internal/objective-canonical/` | POST/GET `generation-admissions`, `generation-requests`, `generation-completions`, `generation-terminals`, `planner-applications`; GETs append their job/application ID. POST-only `generation-acceptances` and `generation-producer/admit`. Workload-only; never browser selectors. Genuine base authority remains unavailable. |
| Strategy acceptance/results | PlannerModule's shared receiving factory is called with no arguments and stays closed. Explicit composition needs real Core native/retained-access/credential owners and qualified Meri custody. Frozen v2 is initial-Strategy-only. |
| Server Planner continuation | Durable operation/consent/output accounting survives browser closure. Worker starts only with `OBJECTIVE_PLANNER_CONTINUATION_ENABLED=true`; consent duration must also be valid. Fresh Strategy intake separately requires `OBJECTIVE_STRATEGY_INTAKE_ENABLED=true`, valid duration and native tenant policy. These flags supply no missing authority. |
| Frontend PR80/82 | Only governed generation GET, outputs GET and Strategy intake POST are registered. `governedPlannerReadEnabled` and `governedStrategyIntakeEnabled` remain false; no governed commands/confirm-pair operation. Preview routing still omits governed operations and retains the separate `6542f5b0…` backend pin. |

**PR73 supersedes the missing raw-capture hold in predecessor documents.** The
old qualification reports remain evidence for their own pins, not final-state
bootstrap instructions. See [PR73 HTTP qualification](https://github.com/neo-capiro/capiro-backend/blob/fef07a45a7d1ec5e80ec1c4e80cd782a77261f36/docs/objective-strategy-core-20261017/ADMISSION-RAW-HTTP-QUALIFICATION.md).

## Browser and Meri contract conclusions

Frontend PR80/82 match the Core GET, output, v2 selection, CAS, exact receipt and
error envelopes. Requested source remains distinct from older accounted source.
Fresh intake requires requested revision ID/version to equal the current ready
Objective; exact saved-wrapper recovery runs before that fresh preflight and
survives disabled write policy. Core permits verified historical output ancestry;
the browser receiver is current-requested-source-only. Creation and retained v3
application are distinct. Navigation rechecks both GETs and ordinary current
Planner access. No browser DTO mismatch or duplicate governed framework was found.

The final read-only Node24 check reconstructed Core's generated contract data
from the actual sealed Meri schema/module **without writing either checkout**.
Bytes match exactly; schema SHA256 is
`d461baaaf2300aa7ffd363bc4b58295d22c437360c126884e96433e10ac16ec1`.
Core reader data/JWT/client are unchanged since PR64; public controller/command/
selection/output contracts are unchanged since PR61. This is wire integrity,
not custody or authority qualification. Core decision RS256, purpose-separated
Objective reader v2 Ed25519, and Temporal RS256 are distinct protocols/keys.

## Migration prerequisites, not an execution recipe

Core Objective inventory under `apps/api/prisma/migrations/`:

```text
20281011010000_client_objectives
20281015010000_client_objective_work_intents
20281015020000_client_objective_canonical_plans
20281015030000_client_objective_operational_links
20281015050000_client_objective_work_reconsent
20281016010000_client_objective_workload_delegations
20281017010000_client_objective_strategy_intake
```

No `15040000` migration exists here. The older six are unchanged since PR42;
all seven are unchanged since PR61. Delegations retain `CHECK(enabled=false)`.
Intake requires same-database native/consent/revision helpers and existing
`sp_draft_job`, `sp_strategy`, `sp_version`, `sp_planner_resources`, including
their initialization and Planner grants/RLS successors. All 28 API-strategy
migrations are unchanged across this stack. Continuation/canonical evidence
uses private JSON records with version/full-value CAS, not a new SQL table.
The database owner must reconcile actual migration history, effective privileges,
RLS and global Strategy-ID writer triggers; no applied/live state is inferred.

## Qualification and stopping point

Preserved evidence: PR61 native PostgreSQL **39/39 at eef7cd1b only**; PR63
116/116, PR64 67/67, PR66 28/28, PR70 131/131 and PR73 129/129 with their scoped
TypeScript checks. PR73 includes 59 actual Nest/Node HTTP cases. These counts
overlap and must not be summed or transferred between source pins. This audit
reran no unchanged suites or SQL; only final ancestry, source/remote pin and
cross-boundary byte checks were added. Independent Core/frontend/Meri source
audits found no new independent Core correctness defect.

**Stop this lane here.** Core still needs explicitly qualified genuine
admission/base authority, retained-access/native bindings and purpose-qualified
credentials; the disabled schema/provider fences are not solved by flags.
Fable exclusively owns genuine protected-facts issuance/readback composition,
accepted-job custody, durable replay storage, completion capture and reader
mounting. Sealed PostgreSQL custody remains incomplete/unqualified: uncertain
claim stickiness, final cleanup cancellation/deadline check and adapter tests/
native storage qualification are missing. Pure decoder 13/13 and earlier Meri
130/130 do not qualify that adapter. The reserved table remains
`meri_objective_source.custody`; its SQL was not run.

Use the [single Fable receiving requirement](https://github.com/neo-capiro/capiro-backend/blob/7b39d341f2a5300f37b0a9aab4899fc3dab3ccf3/docs/objective-strategy-core-20261017/CORE-INTEGRATION-AND-RECEIVING-HOLD.md)
with PR73's capture supersession. Require Fable's exact reviewed coherent
receiving commit and qualification, coordinated Core bindings/database authority,
then coherent serving and authenticated frontend qualification. No fake
issue/resolve flow, caller binding or echoed Core publication substitutes for
Meri custody. No further product source, activation, credential, migration,
build, cloud or Meri action is authorized or performed by this final review.
