# Roster source evidence — 2026-10-19

**Source result: the reviewed roster contract is compatible with the settled candidate.** This evidence supports preparation of a frontend source-pin successor. It does not qualify a running image, authorize activation, or extend the preview to meeting or other module routes.

| Reference | Full Git identity |
| --- | --- |
| Previously reviewed roster source | `b97a3286487abcda6a7424cf1dc2812d93b65b3d` |
| Settled Core candidate | `50475125275853299798fc40f8cb119f0b865464` |
| Candidate tree | `c01138fed2e0e89e50f0f54f35c0ff4d4415c9b4` |

No application changes to the settled candidate are proposed here. All source line anchors below refer to that candidate.

## Exact blob evidence

Fifteen of the sixteen inspected files are byte-identical. Paths are repository-relative; the abbreviated column labels refer to the full pins above.

| Path | b97 blob | 504 blob |
| --- | --- | --- |
| `apps/api/src/auth/preview-native-read-mode.ts` | `97af7e528045ee2fd3d65178c750758e0d5f67f0` | `97af7e528045ee2fd3d65178c750758e0d5f67f0` |
| `apps/api/src/auth/preview-native-read.service.ts` | `39cd537a385b4795353efd75ebf6b52cfcf0ebd7` | `39cd537a385b4795353efd75ebf6b52cfcf0ebd7` |
| `apps/api/src/auth/core-roster-preview-http-gate.ts` | `cc495960735e76c4336db801ffc012e9fb33afdb` | `cc495960735e76c4336db801ffc012e9fb33afdb` |
| `apps/api/src/main.ts` | `2eae50fc22e788d6e19ede44f5c2481ac2c77606` | `2eae50fc22e788d6e19ede44f5c2481ac2c77606` |
| `apps/api/src/config/config.schema.ts` | `9d808474d907d0d7c1f24aed2ab9733a0314c529` | `9d808474d907d0d7c1f24aed2ab9733a0314c529` |
| `apps/api/src/clients/clients.controller.ts` | `1cc091440f3ef42f60a639c04885cfa8a1799575` | `1cc091440f3ef42f60a639c04885cfa8a1799575` |
| `apps/api/src/clients/clients.service.ts` | `3ac426cfbe61d84fd0ce01cf23d85e28bb90a756` | `3ac426cfbe61d84fd0ce01cf23d85e28bb90a756` |
| `apps/api/src/clients/clients.module.ts` | `6600a75406947154d9816884648b3f8ae94f68dd` | `6600a75406947154d9816884648b3f8ae94f68dd` |
| `apps/api/src/auth/application-membership.service.ts` | `96a09af20c6b7b976020308f774c39b28095c317` | `96a09af20c6b7b976020308f774c39b28095c317` |
| `apps/api/src/auth/application-membership.ts` | `17cdfca2d8b19bf05322eba99686942fdd8f4a30` | `17cdfca2d8b19bf05322eba99686942fdd8f4a30` |
| `apps/api/src/auth/clerk.service.ts` | `c76489d850b8f2c3355292eb88f6c09cdda8163e` | `c76489d850b8f2c3355292eb88f6c09cdda8163e` |
| `apps/api/src/tenant/tenant-context.middleware.ts` | `5fd5ccc806ff70131141835e5bf36596beba0696` | `af6202689dee19ffad26450a9368133e571e5026` |
| `apps/api/src/memory/memory-wall.helpers.ts` | `0f18c7747067c653dac87829231ae5c28370bcaa` | `0f18c7747067c653dac87829231ae5c28370bcaa` |
| `apps/api/src/auth/application-membership-request.ts` | `9159adae3cfb2d6349a53f43e9ababf57d533f4d` | `9159adae3cfb2d6349a53f43e9ababf57d533f4d` |
| `apps/api/src/prisma/prisma.service.ts` | `d071939ac0f18deccab65794b9be20222c5887e8` | `d071939ac0f18deccab65794b9be20222c5887e8` |
| `apps/api/prisma/schema.prisma` | `4b71ebb51c290e180a4f326b8067d3508da14da5` | `4b71ebb51c290e180a4f326b8067d3508da14da5` |

## Contract and authority comparison

- **Exact request boundary:** `apps/api/src/auth/preview-native-read-mode.ts:15` identifies `core-roster-preview.capiro.ai`. Lines 39–51 require one exactly spelled raw/parsed Host, both feature flags, origin-form `GET /api/clients`, matching path and bounded query. Lines 55–65 permit only `profileStatus`, `sectorTag`, and `includeArchived`. The HTTP gate at `apps/api/src/auth/core-roster-preview-http-gate.ts:9` sets no-store before body parsing; `apps/api/src/main.ts:21` installs it.
- **DTO and response:** `apps/api/src/clients/clients.controller.ts:256` defines the unchanged list DTO. Lines 334–354 select the preview service, reject archived-inclusive reads and return its result directly. `apps/api/src/clients/clients.service.ts:1115–1131` applies tenant scope, wall-visible client IDs and nonarchived status, then the existing logo projection. The array shape and projection have no change between the two pins.
- **Native authority:** `apps/api/src/tenant/tenant-context.middleware.ts:158–172` still evaluates the roster gate first. Lines 645–704 still require an unmarked native Clerk session ID, an online active-session check, an existing active local user/member, matching tenant selectors and no impersonation. These regions have no diff. `apps/api/src/auth/preview-native-read.service.ts:52` retains the membership checks before and after the read and rejects revision drift.
- **Activation contract:** `apps/api/src/config/config.schema.ts:40,43` keeps exact-string true/false flags defaulted to false; line 1289 requires native GETs when roster preview is enabled. Both `PREVIEW_NATIVE_GETS_ENABLED=true` and `CORE_ROSTER_PREVIEW_ENABLED=true` are necessary. This document does not set them.
- **Schema:** the Prisma schema blob is identical between b97 and 504. This proves no schema delta between these two source pins; it does not prove the serving database has the required existing schema.

### Review of the one changed file

The direct diff of `apps/api/src/tenant/tenant-context.middleware.ts` shows:

1. Candidate line 176 adds history-release paths to no-store classification.
2. Lines 724–781 add history provenance, transaction-lock and fresh-observation methods. They are unmounted leaf methods in this candidate.
3. Lines 806–865 move the existing local identity query into a callback that optionally accepts a supplied transaction. The existing query body and ordinary `withSystem` behavior remain. Existing identity calls retain the no-supplied-transaction path; the new history method at line 781 supplies a transaction.
4. The roster gate and native-read path described above are unchanged. No history controller is mounted by this change.

Other changes after b97 concern Meri producer contexts and Directory pagination, outside the inspected roster path. This is a scoped roster comparison, not whole-application equivalence.

## Frontend pin and runtime limits

A frontend contract that hardcodes b97 requires an explicit reviewed successor accepting the full 504 pin. The release coordinator's fresh GitHub readback identifies [frontend draft PR #111](https://github.com/neo-capiro/capiro-frontend/pull/111), head `e6180219b589ae8fced7155d1c451840c8663d94`, based on main `5cd5f20d0f2919dce915a67a46487ce81f3e4f15`. It is open, draft and unmerged. This is the successor source reference; an archive of the old main commit is not successor build evidence.

The frontend reports that `AllowedValues` remains `[""]`, the serving source and image digest remain null, and no activation occurred. Its scope remains initial roster/native reads; the four meeting GETs, PUT and thirteen ordinary fixed reads remain held. This document has not independently built or runtime-tested that frontend head.

Once the actual image digest and serving source are independently qualified, the roster binding must attest the source actually serving it; configuring the old b97 marker for a 504 image is invalid. Preserve the separate legacy native-read binding and its read-only policy.

Runtime qualification remains separate: exact serving image/source, effective flags, existing schema, native session/member behavior, exact roster host routing and the paired frontend origin/source must be checked together. Preserve the existing first-chat GET and authority/bootstrap paths and existing security bindings. This comparison grants no extra routes, migration, tool-policy change or general Modules activation. Meeting reads and PUT remain held; see [MEETING-FOLLOWUP.md](MEETING-FOLLOWUP.md).

Evidence came from `git rev-parse <pin>:<path>` for all sixteen entries and direct `git diff` between the full pins for the middleware file. The scoped `git diff --check` passed. No application code changed and no build, test, deployment or authenticated runtime request was performed for this document.
