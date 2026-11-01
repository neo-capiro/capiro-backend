import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { SiteWorkflowConfiguration, SiteWorkflowManifest, SiteWorkflowReceipt } from '@capiro/shared/site-workflows';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
export type WorkflowRow = { tenant_id: string; site_id: string; workflow_id: string; version: number;
  manifest: SiteWorkflowManifest; manifest_sha256: string; enabled: boolean; request_id: string;
  request_sha256: string; created_by_user_id: string; created_at: Date };
export const workflowDigest = (value: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');
export const configuration = (row: WorkflowRow): SiteWorkflowConfiguration =>
  ({ manifest: row.manifest, manifestSha256: row.manifest_sha256, enabled: row.enabled });
export const receipt = (row: WorkflowRow): SiteWorkflowReceipt =>
  ({ requestId: row.request_id, configuration: configuration(row), savedAt: row.created_at.toISOString() });
export async function currentWorkflow(tx: Prisma.TransactionClient, tenantId: string, siteId: string, workflowId: string) {
  const rows = await tx.$queryRaw<WorkflowRow[]>`SELECT * FROM meri_site_workflow_revisions
    WHERE tenant_id=${tenantId}::uuid AND site_id=${siteId} AND workflow_id=${workflowId}
    ORDER BY version DESC LIMIT 1`;
  return rows[0] ?? null;
}
export async function allWorkflows(tx: Prisma.TransactionClient, tenantId: string) {
  // A maximum of 256 identities is enforced on insertion, so this is complete, not a truncated authorization list.
  return tx.$queryRaw<WorkflowRow[]>`SELECT DISTINCT ON (site_id,workflow_id) *
    FROM meri_site_workflow_revisions WHERE tenant_id=${tenantId}::uuid
    ORDER BY site_id,workflow_id,version DESC`;
}

