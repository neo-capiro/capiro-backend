# Client Intel historical requirements and retirement map

This source-only slice retires exactly two May 26, 2026 Client Intel implementation/backlog prose files from the active cleanup tree. The complete original requirements, unfinished items, historical claims and conflicting mappings remain preserved. All other documents and the separate rebuild remain unchanged.

## Full original requirements

- [Implementation plan: complete A–I requirements, implementation sequence and historical done gates](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/2026-05-26-client-intel-tab-redesign-v1-implementation-plan.md).
- [Ticket backlog: complete original priorities, dependencies and acceptance narratives](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/2026-05-26-client-intel-tab-redesign-v1-ticket-backlog.md).

Both original files are byte-identical across the nine declared component source snapshots, the protected parent802 rebuild, the checked cleanup trees and both protected tag-only Clio/Onboard source candidates. Source observation does not admit unknown component sources or establish actual image build trees.

Keep [the Client Intel acceptance checklist](../../plans/2026-05-26-client-intel-tab-redesign-v1-acceptance-criteria.md) and [the May 28 visual QA evidence](../../plans/2026-05-28-client-intel-v1-visual-parity-qa-evidence.md) active and byte-for-byte unchanged. The checklist retains API F1–F5 payload/aggregation, tenant/client scoping, freshness, SQL-view naming and action-target requirements. Existing API implementation and test identities remain unchanged.

The old plans label themselves execution trackers and claim ticket-to-criterion mapping. Their mappings require reconciliation: backlog C-002 is “FEC three-column flow visual” while acceptance C2 is “ROI chart.” Preserve each original version; canonical mapping and completion remain owner decisions. Every original A–I requirement and unfinished ticket stays available through the full links above. Historical I4/I5/I6 sign-off/test claims remain historical evidence. This retirement does not mark an unfinished item complete, select current API semantics or establish new acceptance results.

## Exact recovery checkpoint

Pre-retirement commit: `ab52a0c4b04eeda1ebba2dfab1314282cb88213b`; tree: `9a18a015527820e98d21e9256f8bbdc07627b60d`; protected conventional ref: `refs/tags/cleanup-recovery/20261012/before-client-intel-plan-retirement`.

| Active historical path retired | Original Git blob | Bytes | Exact readonly archive |
| --- | --- | ---: | --- |
| `docs/plans/2026-05-26-client-intel-tab-redesign-v1-implementation-plan.md` | `4382ce7168c2f5bcdb225fff0ef65032f308639b` | 15,219 | `client-intel-plans-before/2026-05-26-client-intel-tab-redesign-v1-implementation-plan.md` |
| `docs/plans/2026-05-26-client-intel-tab-redesign-v1-ticket-backlog.md` | `de9e352a6c46b91099d735040a505e1aef497219` | 10,348 | `client-intel-plans-before/2026-05-26-client-intel-tab-redesign-v1-ticket-backlog.md` |

Archives are under `/workspace/backend-cleanup-recovery-20261012/`, mode `0444`. Their SHA-256 identities and full original/checkpoint URLs are recorded in [CLIENT-INTEL-PLAN-RETIREMENT.json](CLIENT-INTEL-PLAN-RETIREMENT.json) and the readonly `client-intel-plans-before/CHECKPOINT.json`.

Complete history custody combines `declared-deployed-revisions.bundle` (complete Core history) with `client-intel-plans-before/source-checkpoint.bundle` (later ancestors, requiring Core `1e99f0921b207318c6d2abf03927b5c4daa5768b`). The latter has SHA-256 `23ce4225f555e6f77a6a87537913078f5b67569c5fc4642c8c7d2c0d365fbab2`. The integration owner verified a separate bare restore and exact archived/restored bytes; this slice verified the readonly archives, tag target and bundle hash before removing active paths. Local refs are conventional protections; immutable commit/blob identities and readonly bundle hashes remain the custody authority. No history or permanent deletion is performed.

## Reader and proof obligations

The checked source contains no named required-file, runtime/worker/schedule/API, prototype, finding or manifest dependency on either retired path. Constructed roots, scoped Markdown/template readers, build/CI/publication hooks and archive contracts were inspected; the conclusion uses more than filename searches. Other named documentation/JSON/prototype inputs remain held.

The parent802 rebuild has a positive whole-tree archive consumer: `apps/e2e/scripts/make-source-archive.mjs:76` archives committed HEAD, including planning prose while present. Its required inputs and measured manifest use `apps/e2e/lib/source-identity.mjs`'s canonical roots; `docs` and these two paths are outside them. `sameIdentity` compares fingerprint and exact HEAD/tree. A later adoption of rebuild code on a changed source commit therefore needs a fresh separately versioned archive, source manifest, archive receipt and applicable source-bound proofs. Preserve every old artifact at its recorded identity; keep all required inputs, test identities, measured rows and historical results unchanged. A docs-only edit may preserve measured bytes, while HEAD/tree/tar change; additional integration work may change the measured fingerprint too.

The baseline manifest observed within parent802 has `head:null` and `treeHash:null`. Current `verifyManifest` requires exact 40-hex provenance, so that historical artifact is not validated source-bound proof. Preserve its original nulls/hash; never relabel or backfill it to claim a pass. Produce actual fresh valid evidence only in its separately authorized qualification lane.

Core has no such E2E archive/identity/manifest chain. This docs slice does not import it or generate proofs. Core Phase1 local tar use extracts OCI image metadata. Frontend retirement and native/coverage/CI acceptance remain separate obligations; none is claimed here.

## Documents held

Retain all acceptance/QA evidence, operating/API/runbooks/contracts, migration/incident/recovery/ADR records, executable planning assets, reports, unknown Clio/Onboard possibilities and new rebuild packets. Preserve the unpublished Engagement report without inspecting its contents. `docs/plans/cleanup4-progress.md` remains exclusively reserved to the rebuild owner. Only the two historical prose paths above are retired.
