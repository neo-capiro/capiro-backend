# PR78 cleanup receiving record

## Source and scope

This source-only receiving branch starts at draft Core PR78
`bcdd689956e1aff3fa316103e75ec60ebe024fda` (tree
`103810f472e09237836eed4a8a8682e36632c224`). It preserves the PR48
first-chat lineage through PR62 and PR78. Seven reviewed cleanup commits from
the divergent PR71–77 branch were applied in order; no merge of that branch or
Objective/read-observation branch was made.

| Original cleanup commit | Receiving commit | Scope |
| --- | --- | --- |
| `4eb9483638a3e14697855f0d68bbb486d9d523cc` | `2754b44cd0b8fdb8f307c05e27841b1cbaa8caa6` | Seven regenerable Session 5 JSON outputs and their inventory |
| `5b98c8929538257f1945364759f9b6f2535a55f5` | `d040ea41f9943b40b49373f2f129fa631eb49ada` | Backend-only build boundary |
| `cadd71a2067f33d24246a18630c31da646e180f4` | `087b5dcf262762534c3910c8e8bd676ef8d30c35` | Build qualification and completion-service return type annotations |
| `1f301c53c578386a99f6108b10d3a46c4010b946` | `5de89ebb684d23804a5721ac3645d8022e14721d` | Move AI credential spec and remove unused reexport |
| `8f83087ef3c1380ebcdf1dd9745417e9bc21e86a` | `9e20cf8b13e1a2b21b94cf5aed77b9cd446bd241` | Directory type extraction |
| `6d7867b389331f79a29884d3207dcaf501d1fc98` | `4f575b56ff040c8688b7b3ef4dac79cf814bebfd` | Directory contact mapping extraction |
| `1b232adc3f40fdefba327caee4e5ef1eb6ef365d` | `a8a8e1979e80d8285c4d00e6eaec66503408c38f` | Directory browse extraction |

The reviewed application head before this report is
`a8a8e1979e80d8285c4d00e6eaec66503408c38f`, tree
`eb96fc5ecc2fe232ab9bf0381d300a8f6d4e49f8`. The 26 cleanup paths have
no path intersection with the 69 PR78-lineage paths relative to their common
base. All implementation-path blobs for these cleanup changes match PR77;
the resulting difference from PR77 in the changed-path comparison consists of
two PR77-only backend-cleanup documents absent from PR78. `git diff --check`
passed for the committed application diff.

Committed-tree metrics, measured by Git objects rather than the sparse working
tree: PR78 has 28,330 tracked files and 571,826,514 blob bytes; the composed
application tree has 28,330 tracked files and 568,833,409 blob bytes, a net
reduction of 2,993,105 bytes. Nine paths were added, nine deleted, and nine
existing blobs changed. Seven of the deleted paths are the 3,019,411-byte
Session 5 materialized outputs; the other deletions are an identical-blob spec
move and an unused 161-byte controller reexport. The retained source PDFs,
request manifests, rendered pages, frozen corpus, schemas, migrations,
licensing, runbooks, and release evidence remain in Git.

## Contract and consumer review

- Public Directory list/detail routes and DTO boundaries are unchanged. The
  internal browse and contact routes remain distinct and guarded. The browse
  extraction uses the existing full contacts query and trims its response. No
  Personnel detail endpoint is added.
- The canonical guarded `POST /api/internal/ai-credentials/resolve` remains
  registered from `apps/api/src/ai-credentials`. Its old Engagement shim was a
  two-line reexport; the spec and active verification-script reference moved
  together. Historical manifest fixtures were not rewritten.
- The removed Session 5 outputs are regenerable from retained request/source
  inputs using `apps/defense-parser-orchestrator/scripts/materialize-live-inputs.mjs`.
  The original cleanup qualification matched all seven output Git blobs after
  regeneration. Restore committed outputs from
  `b90b3ddb9d4db5e7077473b5191173e2543db18d` if needed; see
  [BACKEND-ONLY-INVENTORY.md](BACKEND-ONLY-INVENTORY.md) for per-file SHA-256,
  recovery command, and retained input checks.
- `build:backend` and `typecheck:backend` exclude Web, Onboard Web, and E2E.
  They do not qualify a frontend image or browser flow. Existing Web,
  onboarding SPA, marketing, older Meri consumers, and the defense runtime
  source mirror remain because their entrypoints/build or retention decisions
  have not been replaced. See [BACKEND-BUILD-BOUNDARY.md](BACKEND-BUILD-BOUNDARY.md)
  and [BACKEND-BUILD-QUALIFICATION.md](BACKEND-BUILD-QUALIFICATION.md).
  Those two documents record historical PR71/72 and frontend PR81 findings;
  they do not qualify the current frontend PR86 source or image.

## Combined-tree checks

All passing checks below ran after composition on the receiving tree. Node
22.23.3 and pnpm 9.12.0 were pinned locally. The frozen backend-filtered
install used a task-owned offline store and `--ignore-scripts`; 17 of 20
workspace projects installed, 1,437 packages reused, zero downloaded, and
`pnpm-lock.yaml` was unchanged. Prisma 5.22.0 clients were generated locally
from the checked-in schemas, using existing exact-version Windows engine
binaries; no database connection or migration was used.

| Check | Actual result |
| --- | --- |
| Three offline ALB listener rule specs | 41/41 passed |
| Focused first-chat CDK construct spec | 3/3 passed; local synth only |
| Eight affected API Jest suites (Directory, AI credential controller, client-profile completion) | 111/111 passed, `CLEANUP_API_WORKER_DB=0` |
| `pnpm run build:backend --env-mode=loose` | 16/16 tasks passed, zero cached, 2m25.925s |
| `pnpm run typecheck:backend --env-mode=loose` | 23/23 tasks passed, seven cached, 4m52.699s; `PE_PHASE_A_B_SAFETY_OK` |

The final build and typecheck outputs are retained as
[`preview-cleanup-build-final.log`](receiving/preview-cleanup-build-final.log)
and [`preview-cleanup-typecheck-final.log`](receiving/preview-cleanup-typecheck-final.log).
Only trailing blank spaces were removed from the committed log copies. Their
SHA-256 values are respectively
`95648fdc63634a9cd368a5a4e0f02a37a75cbefb4c3488d5b34e696413fa0fbb`
and `9b45c05c54fe1feccd35c2e5fb880f3ace9954c5f468317c9a0ee624ec0d6c27`.
The untouched task-local raw captures hash to
`e6502b94a94af758056b2312ffd2e0737279a79de16ede0e2e23f86b5ea6b2e7`
and `47996b9664b222d1fa2e5589494d8ec79529d155e69f9f5e30152498e5dbdafd`.

Earlier setup attempts are retained as failures, not counted as passing
checks: an unfiltered offline install lacked an unrelated frontend Clerk
tarball; script-free install initially lacked generated Prisma/shared outputs;
Prisma's first engine checksum download was blocked by the sandbox; the first
two combined builds stopped on those task-local prerequisites and filtered
environment propagation. With the existing exact-version engines, generated
clients, and Turbo `--env-mode=loose`, the final combined build passed. A
sandboxed `tsx` user lookup also produced Windows `ENOMEM`; the same final
typecheck passed in the approved host context without a source change. None
of these attempts accessed a live database or AWS.

## Coverage and receiving disposition

In the [cross-app remaining plan](https://github.com/neo-capiro/capiro-backend/blob/5f719149da2d8d011f1ab980a950d9692585826e/docs/deployment/CAPIRO-REMAINING-DEPLOYMENT-PLAN-20261017.md),
this is the narrow C3 cleanup receiving slice and preserves C1's first-chat
source lineage. The source is integrated on this branch with combined affected
contracts, build, and typecheck; it is not an image, migration, deployment, or
live-authentication qualification. No AWS, listener, credentials, migration,
production database, frontend, or Meri change was made here. No Objective or
read-observation source was received; those remain separate decisions.

Next receiving work is to review this exact PR against the selected coherent
Core release candidate. Any runtime-byte change after image qualification
requires a new affected image receipt. Broader C3 organization remains open:
map remaining active consumers, finish approved frontend/onboarding/marketing
cutovers, and retain audit/recovery inputs until their owners confirm
retirement. C1 still needs qualified bounded GET serving and real native
identity/member/client proof before first-chat activation.
