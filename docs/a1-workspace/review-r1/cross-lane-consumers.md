# A1 R1: current Meri Workspace approval consumer scan

Scanned `neo-capiro/meri-greenfield` at exact current revision `eb6579204f495eb35140f4e1cb013b641913da5f`. The read-only source inventory found **no consumers of the removed Workspace approval endpoints, DTOs, persistence model name or blueprint approval keys** in `apps/`, `packages/` or `scripts/`.

The scope is the Workspace removal only. Meri browser/bash approval requests and Meri notification preferences remain separate, supported contracts. A supplementary generic `ApprovalRequest` search found 50 lines in 16 native Meri files (browser/bash approval code, settings preferences and generated preference contracts); these are not Workspace consumers and were not edited.

## Exact scan

Pattern (case-insensitive extended regular expression):

```text
approval-requests|delivery/preflight|CreateApprovalRequestDto|ApprovalDecisionDto|WsApprovalRequest|wsApprovalRequest|ws_approval_requests|clientFacingApprovalRequired|permittedApproverRoles|workspace[./:]approval|workspace[./:]preflight
```

Command:

```sh
git grep -n -i -E 'approval-requests|delivery/preflight|CreateApprovalRequestDto|ApprovalDecisionDto|WsApprovalRequest|wsApprovalRequest|ws_approval_requests|clientFacingApprovalRequired|permittedApproverRoles|workspace[./:]approval|workspace[./:]preflight' eb6579204f495eb35140f4e1cb013b641913da5f -- apps packages scripts ':!*.png' ':!*.pdf' ':!*.docx' ':!*.xlsx' ':!*.zip' ':!*.jpg' ':!*.mp4' ':!*.gif'
```

- Exit code: `1` (Git grep's no-match result).
- Match lines: `0`.
- Read-error lines: `0`; stderr was empty.
- `permittedApproverRoles` and `clientFacingApprovalRequired` are both explicitly included.
- Binary artifact formats were excluded; live source, tests, configuration, generated contracts and nearby text documentation were scanned.

## Local object availability

The commit was present in `/workspace/scratch/956fe6753532/meri-p1`, but its primary partial-clone object store did not contain all source blobs. Initial broad reads encountered unavailable blobs and disk errors during Git's automatic lazy fetch; those incomplete runs are not used as clean-scan evidence.

The final complete scan set `GIT_NO_LAZY_FETCH=1` and read the existing local stores below through `GIT_ALTERNATE_OBJECT_DIRECTORIES`. It completed with no object-read errors and required no fetch, checkout, source edit or ref change:

- `/workspace/scratch/4fdb45064cf2/meri-greenfield/.git/objects`
- `/workspace/scratch/bfc7c68b4e66/meri-p2/.git/objects`
- `/workspace/scratch/f4c316385060/meri-greenfield/.git/objects`
- `/workspace/scratch/f9ef768a0d30/meri-greenfield/.git/objects`

Raw exact command, environment and empty stdout/stderr receipt: `/dev/shm/a1-r1-meri-final-workspace-consumers.json`. This is a static consumer inventory, not a live integration qualification. No cross-lane changes were made.

## Frontend and Core companion scans

The same retired endpoint/type/key scan found no callers in tracked `apps/`, `packages/` and `scripts/` at frontend `main` `84f5ba29fe868b6b1ec701a9a3f383e0d14cb352`, or in the #117 working source. The only remaining Workspace-template approval controls consume canonical `OutreachTemplateSpec.guardrails.approvalMode`; they are Outreach sender controls, not retired Workspace draft approvals. The frontend review receipt lists their exact three files. Native Meri presentation approval models and Portfolio artifact controls remain untouched.

The backend companion scan outside `apps/workspace` found no callers of the removed Workspace endpoints/types or blueprint keys. Within the staged Workspace production source, this exact check returned no matches:

```sh
git grep --cached -n -E 'ApprovalService|DeliveryService|CreateApprovalRequestDto|ApprovalDecisionDto|requireReleasedApproval|permittedApproverRoles|clientFacingApprovalRequired|approval-requests' -- apps/workspace/src ':!*.spec.ts'
```

A broader case-insensitive `approval` grep retains only three pre-existing documentation comments: `src/auth/clerk.service.ts` and `src/auth/tenant-context.ts` describe change-control approval for auth edits; `src/drafts/editorial-output.ts` records design approval of frozen report formats. They are not executable approval workflow. Removal/regression tests retain retired endpoint literals and legacy-config samples deliberately. Prisma keeps the stored-data declarations with Neo's exact retention marker; historical SQL/evidence remains intact. No runtime reads/writes of Workspace approval records or hidden controls remain.
