import type { CreateResearchPortfolioOutputDto } from '@capiro/shared';
export interface RetainedOutputWorkspace {
  jobId: string | null;
  create: {
    operationKey: string;
    payload: Omit<CreateResearchPortfolioOutputDto, 'operationKey'>;
  } | null;
  filing: { operationKey: string; artifactId: string; clientId: string; confirmed: boolean } | null;
}
export const emptyOutputWorkspace = (): RetainedOutputWorkspace => ({
  jobId: null,
  create: null,
  filing: null,
});
export const outputWorkspaceKey = (scope: string, portfolioId: string) =>
  `capiro:research-portfolio-output:v2:${JSON.stringify([scope, portfolioId])}`;
export function readOutputWorkspace(key: string): RetainedOutputWorkspace {
  const text = localStorage.getItem(key) ?? sessionStorage.getItem(key);
  if (!text) return emptyOutputWorkspace();
  const value = JSON.parse(text) as RetainedOutputWorkspace;
  if (
    !value ||
    (value.jobId !== null && typeof value.jobId !== 'string') ||
    (value.create &&
      (typeof value.create.operationKey !== 'string' ||
        !value.create.operationKey ||
        value.create.operationKey.length > 128 ||
        value.create.payload?.format !== 'csv' ||
        !Array.isArray(value.create.payload.selectedSections) ||
        value.create.payload.selectedSections.some(
          (section) => !['analytics', 'totals', 'contributions', 'sources'].includes(section),
        ) ||
        typeof value.create.payload.includeSourceAppendix !== 'boolean' ||
        (value.create.payload.snapshotId !== null &&
          typeof value.create.payload.snapshotId !== 'string'))) ||
    (value.filing &&
      (typeof value.filing.operationKey !== 'string' ||
        !value.filing.operationKey ||
        value.filing.operationKey.length > 128 ||
        typeof value.filing.artifactId !== 'string' ||
        !value.filing.artifactId ||
        typeof value.filing.clientId !== 'string' ||
        !value.filing.clientId ||
        typeof value.filing.confirmed !== 'boolean'))
  )
    throw Error('The retained output request is invalid. Do not send a replacement operation.');
  // A remount cannot prove whether an in-flight request committed. Reconcile the exact identity.
  return { ...value, filing: value.filing ? { ...value.filing, confirmed: false } : null };
}
export function persistOutputWorkspace(key: string, value: RetainedOutputWorkspace): void {
  localStorage.setItem(key, JSON.stringify(value));
}
