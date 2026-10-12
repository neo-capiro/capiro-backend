# Integration and ownership

Baseline is reviewed composition `802bbd0b2c510a44e46a9952d8127e7edc55aaaa`, tree `6c11b1094aadcbf6645e759204f72b6f87c8982a`. This branch lives in `/tmp/capirov2-cleanup-meri-local-dispatch-conversion`; original heads and worktrees are preserved. Root authorized this Meri conversion after earlier retirement coordination holds. Earlier audit holds are historical, not a current implementation blocker.

| Path/owner | This slice | Composition responsibility |
| --- | --- | --- |
| `apps/api/src/meri/meri-tools.service.ts` | One import plus `executeScoped` body | Preserve full surrounding owner, private methods and Q wording |
| `apps/api/src/meri/meri-local-dispatch.ts` | New pure selector; runtime `executeMeriLocalDispatch`; types `MeriLocalToolName`, `MeriLocalDispatchRegistry` | Runtime import from `./meri-local-dispatch.js`; type-only canonical `MeriCapability` import |
| `apps/api/src/meri/meri-local-dispatch.equivalence.spec.ts` | Frozen-switch inert equivalence | Import pure selector only; parse fragments instead of loading service graph |
| `docs/cleanup-meri-local-dispatch-conversion-20261012/**` | Oracle, raw evidence, contract | Independent reviewer appends its own receipt; do not overwrite failures |
| Shared capability registry/barrel, module, proxy, RP/ALS/request-policy owners | Unchanged | Byte equality recorded; 134 core + five proxy capabilities |
| Root guards/profile JSON/package/CI | No changes | Root owns updated carrier fingerprints and bounded isolated CI configuration |
| Tango, Workspace Cascade, Strategy/report-context conversions | No changes | Separate owners; do not mix unpublished source |
| Declared-production newsletter lineage C/W | No changes | Separate reconciliation/open release dependency; this conversion does not unify that lineage |
| EngagementService reporting work | No access or edits | Separately scoped unpublished work remains owned by its existing agent |

No dependencies, services or stores are added. The existing cached dependency directories are linked locally read-only; those symlinks are not deliverables. No package-manager install, native Prisma generation/download, database/migration execution, provider/model/message/upload/customer/credential/AWS operation occurs.

Root will rotate an independent reviewer and publish after acceptance. This agent does not publish, merge main or deploy. Acceptance is bounded to source structure, strict source typing where recorded, and inert equivalence, with native/application acceptance still open.
