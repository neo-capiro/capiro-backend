# Independent review: inactive Engagement preview proposal

**Disposition: no unresolved finding in this inactive source proposal.** The packet is reviewable preparation for later owner allocation and qualification. It does not approve admission, a target connection, runtime activation, deployment or completion of the Engagement rebuild. Review date: 2026-10-16 UTC. The reviewer authored none of the matcher, preflight or source-preservation implementation; only this review file was written during the final review.

The reviewed base is `016e79b585c14f20d13669e13c987c01e3dd29dd`. Independent read-only inspection confirmed HEAD at that pin, no application/script/shared-package diff against it, and Git-visible additions confined to this documentation packet. All 23 files listed in [QUALIFICATION.json](QUALIFICATION.json) matched their recorded byte counts and SHA-256 values; the actual packet contained exactly that set, excluding QUALIFICATION itself and this later review. WIRE remained `64181558d22ccd71bf1b09f5644a2431e591567cd2b77913f9a6471b7004e8e2`. No existing implementation or evidence was edited by this reviewer.

## Technical findings

The [matcher](routing/plan-preview-candidate.mjs) binds the server-owned operation key, exact uppercase Core method and canonical `/api` pathname together. Its nine tuples agree with the preserved controller/manifest. Literal actions such as `reorder`, and unsupported siblings such as `recommendations`, cannot become UUID identifiers. Cross-operation/root-method collisions, broader or nested paths, alternate bases, complete URLs, encoding, dot segments, query/fragment text, whitespace, trailing slashes, uppercase identifiers and non-string coercions fail closed. Structural UUID matching adds no UUID-version policy; the existing schema normalization and Core UUID pipe remain authoritative. Fixed searches found no application/script imports of this proposal.

The seven exported legacy regex strings remain broader path-only evidence. They cannot supply method, UUID, origin, browser-RPC or actor/client authorization. The matcher deliberately performs no URL parsing, origin authentication, backend selection or dispatch. A future caller must retain the fixed-operation, server-owned base, closed-input and existing authentication boundaries described in [FRONTEND-COORDINATION.md](FRONTEND-COORDINATION.md). The packet correctly leaves the legacy caller/map and new-frontend server-preview ownership unresolved rather than treating collision-review receipts as an activation allocation.

The [authorization audit](authorization/README.md) is accurately labeled source preservation. Its helper compares 27 pinned baseline sources, detects out-of-packet Git-visible changes, and its tests mutate actual baseline strings to verify drift detection. Those checks preserve the existing current actor/membership/role, client-wall, transaction/fence, list/history and actor-scoped receipt sources. They do not simulate user denials or execute Nest, Clerk or database authorization. The packet keeps the coordinated three-read preview contract separate from manual-plan CRUD and makes no fresh HTTP-status or dedicated-backend capability claim.

The [preflight SQL](preflight/role-acl-snapshot.sql) has the intended four-statement envelope: read-only repeatable-read BEGIN, exact transaction-local `search_path = pg_catalog, pg_temp`, catalog SELECT, ROLLBACK. Documentation requires separate ordered execution on one connection, with the path established before SELECT parsing/preparation and the database-name value bound only to that SELECT. The snapshot reports the path and the [assessor](preflight/assess-role-acl.cjs) requires its exact value. This addresses unqualified operator/type lookup, including implicit temporary-type precedence, without changing persistent settings or roles. No collector or automatic connection exists.

The assessor checks exact four-table identity/ownership, current expanded/native ACLs and grant options, history-column UPDATE, required app privileges, and all-role matrices. Per-membership INHERIT and SET paths, mixed SET-then-INHERIT owner authority, implicit owner regrant power, PUBLIC grants and provider-role caveats are covered. ADMIN authority conservatively yields UNKNOWN. Missing, malformed, contradictory, cyclic or unsupported observations cannot qualify. Current ACLs remain distinct from future default grants. The trusted coherent collector-output requirement, inability to attest coordinated offline omissions, point-in-time limits and blanket-grant requalification requirement are explicit. PASS remains a narrow necessary ACL precondition, not permission to activate.

## Evidence inspected

No tests, compiler, browser, native SQL or target queries were started by this reviewer. Saved Node v24.19.0 receipts and their source inputs were inspected:

| Receipt | Observed result and limit |
| --- | --- |
| [Routing](routing/offline-node-results.json), [TAP](routing/offline-node.tap) | 10/10 pure matcher groups; exact manifest methods, handlers, class RolesGuard and standard_user metadata. No HTTP/framework dispatch. The initial wrong relative fixture path is disclosed and the repaired test does not weaken expectations. |
| [Source preservation](authorization/offline-node-results.json), [TAP](authorization/offline-node.tap) | 45/45 offline checks, including 40 source-removal mutations and 27 source pins. No dynamic application authorization. |
| [Preflight](preflight/offline-node-results.json) | 65 synthetic assessor plus 22 SQL lexical checks, 87/87. All five recorded input hashes matched current source. No PostgreSQL parser or execution; the older 62-case V8 receipt is explicitly historical. |

The combined 142 count is offline-only. Key SHA-256 fingerprints at this checkpoint are:

| File | SHA-256 |
| --- | --- |
| Packet QUALIFICATION | `fa894c837c8f9e35ff50f5e8752689e04a1bca900ec78246d10244f9790e12cb` |
| Matcher | `158843a31e0afcb6cbef2fd076111e6422c7709e84f266b7d9484f22f500a7d6` |
| Routing receipt | `bb28b265d96e17ad0a739de9c5db81bc0fa84251f2cffd389b41f29884db03bd` |
| Authorization pins | `10a6989cc226fa141aae8008bd74a824420666d5630468b76ebe32281fbb1f0c` |
| Authorization receipt | `0bcd573b4a5f7137ab7f2405f019e028c4d012ce9b9af8bb23146ba3f43a79d7` |
| Preflight SQL | `d4b6c988c7a0550535919905067043cf986c62077377032a4c339e367baf73b1` |
| Preflight assessor | `9691248638009dbca88b1a084f84eb6e5b6ff21ae76dfcc1474c406bfbfe6d4b` |
| Preflight receipt | `46e52ec07d1f716740a902e8d858d0c6e1d4e2abeabe232878238e9c73bd9c0b` |

## Remaining adoption blockers

Allocate an explicit owner for active legacy/new-frontend admission and call-site changes, with the exact method/operation interface and dedicated reviewed backend source/target binding. The existing three-read binding does not establish manual-plan CRUD capability. Separately allocate native PostgreSQL16 parsing/execution of this new catalog query; then separately authorize and identify any target read and retain its endpoint-bound, unedited snapshot. Finally qualify authentication, HTTP/framework dispatch, browser behavior and the exact selected runtime/configuration. None of those actions is pending or authorized by this packet.

The prior implementation's broader compiler and inherited generator/Krisp/Newsletter limits remain separate. The new seven-path integration gap is not recast as inherited debt. No Meri, shared contract, migration, credential, global configuration, provider, paid job, merge or deployment change is accepted by this review. The publishing owner must supply the final immutable commit/tree and publication manifest, including this review's final bytes.
