# Directory mapper extraction result

Seven pure detail projections now live in `apps/api/src/directory/directory-detail-mappers.ts`. The service retains all seven private method signatures as raw-input forwarders and every existing public call site. The helper has only a type import. Nest providers, routes, source loading, current-office selection, photo provenance, lookup, authorization and all native tests remain unchanged.

The facade decreases from 3,775 to 3,700 physical lines. This is a cohesive module extraction, not repository line reduction: the helper and meaningful fixture tests increase total source. Exact source identity and the corrected 112-line original boundary are in `evidence/directory-implementation.json` and `DIRECTORY-MAP-CORRECTION.md`.

Eight focused builtin cases pass, zero failures/skips, in one Node process with 128 MiB V8, no child execution or services, and a 120-second hard wall. Actual PID 37420 exited0; sampled peak working set was 62,750,720 bytes. Raw stdout/stderr and receipt are retained. The builtin TypeScript parser warning is recorded; it is not an application/compiler qualification claim.

Seven fixture tables cover complete DTO fields, order, nullish defaults, original numeric coercions, strict booleans, preferred-name behavior, admitted array objects and unchanged input. The eighth case checks forwarding, type-only imports and single algorithm ownership, with actual negative controls. It explicitly allows unrelated service changes; ongoing CI does not freeze the entire 143-KiB facade.

The separate explicit `verify-directory-extraction-source.mjs --run` proof also passes. It reconstructs the complete original service and all eleven callers at the sealed parent. That snapshot is one-time transition evidence, not a permanent current-CI obligation. Independent read-only review found no concrete extraction blocker.

Existing Directory Nest/public-entrypoint tests, strict typing and application builds remain for the shared integrated checkpoint. No install, provider, database, image or runtime action occurred.
