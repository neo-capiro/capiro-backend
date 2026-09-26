import type { AxiosInstance } from 'axios';
import type {
  ChangeResearchPortfolioLifecycleDto,
  CreateResearchPortfolioClientLinkDto,
  CreateResearchPortfolioDto,
  CreateResearchPortfolioMemberDto,
  DecideResearchPortfolioMembersDto,
  PutResearchPortfolioGrantDto,
  ResearchPortfolioDetailDto,
  ResearchPortfolioListResponseDto,
  ResearchPortfolioMutationReceiptDto,
  ResolveResearchPortfolioMemberDto,
  UpdateResearchPortfolioDto,
  AssignResearchPortfolioReviewDto,
  DecideResearchPortfolioReviewDto,
  ReopenResearchPortfolioAnnualReviewDto,
  ResearchPortfolioAnnualReviewDto,
  ResearchPortfolioImportActionDto,
  ResearchPortfolioImportDetailDto,
  ResearchPortfolioImportJobDto,
  ResearchPortfolioReviewDto,
  ResearchPortfolioReviewMutationReceiptDto,
  CreateResearchPortfolioImportDto,
  CreateResearchPortfolioOutputDto,
  CreateResearchPortfolioSnapshotDto,
  CreateResearchPortfolioSubscriptionDto,
  ResearchPortfolioAnalyticsDto,
  ResearchPortfolioChangeDto,
  ResearchPortfolioClientFileReceiptDto,
  ResearchPortfolioEventRecipientStateDto,
  ResearchPortfolioOutputArtifactDto,
  ResearchPortfolioOutputJobDto,
  ResearchPortfolioSnapshotDto,
  ResearchPortfolioSnapshotSummaryDto,
  ResearchPortfolioSubscriptionDto,
  SaveResearchPortfolioOutputToClientDto,
  UpdateResearchPortfolioEventStateDto,
  UpdateResearchPortfolioSubscriptionDto,
} from '@capiro/shared';

export const researchPortfolioKeys = {
  all: ['research-portfolios'] as const,
  detail: (id: string) => ['research-portfolios', id] as const,
  reviews: (id: string, lane: string) => ['research-portfolios', id, 'reviews', lane] as const,
  annualReview: (id: string) => ['research-portfolios', id, 'annual-review'] as const,
  import: (id: string, jobId: string) => ['research-portfolios', id, 'imports', jobId] as const,
  changes: (id: string) => ['research-portfolios', id, 'changes'] as const,
  subscriptions: (id: string) => ['research-portfolios', id, 'subscriptions'] as const,
  analytics: (id: string) => ['research-portfolios', id, 'analytics'] as const,
  snapshots: (id: string) => ['research-portfolios', id, 'snapshots'] as const,
  snapshot: (id: string, snapshotId: string) => ['research-portfolios', id, 'snapshots', snapshotId] as const,
  outputJob: (id: string, jobId: string) => ['research-portfolios', id, 'outputs', jobId] as const,
};

export interface ResearchPortfolioChangesResponse {
  items: readonly ResearchPortfolioChangeDto[];
  nextCursor: string | null;
}

export function newIdempotencyKey(operation: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `research-portfolios:${operation}:${suffix}`;
}

export async function listResearchPortfolios(api: AxiosInstance): Promise<ResearchPortfolioListResponseDto> {
  return (await api.get<ResearchPortfolioListResponseDto>('/api/research-portfolios')).data;
}

export async function getResearchPortfolio(api: AxiosInstance, id: string): Promise<ResearchPortfolioDetailDto> {
  return (await api.get<ResearchPortfolioDetailDto>(`/api/research-portfolios/${encodeURIComponent(id)}`)).data;
}

export async function createResearchPortfolio(
  api: AxiosInstance,
  input: Omit<CreateResearchPortfolioDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.post<ResearchPortfolioMutationReceiptDto>('/api/research-portfolios', {
    ...input,
    idempotencyKey: newIdempotencyKey('create'),
  })).data;
}

export async function updateResearchPortfolio(
  api: AxiosInstance,
  id: string,
  input: Omit<UpdateResearchPortfolioDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.patch<ResearchPortfolioMutationReceiptDto>(`/api/research-portfolios/${id}`, {
    ...input,
    idempotencyKey: newIdempotencyKey('update'),
  })).data;
}

export async function changeResearchPortfolioLifecycle(
  api: AxiosInstance,
  id: string,
  action: 'archive' | 'restore',
  input: Omit<ChangeResearchPortfolioLifecycleDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.post<ResearchPortfolioMutationReceiptDto>(`/api/research-portfolios/${id}/${action}`, {
    ...input,
    idempotencyKey: newIdempotencyKey(action),
  })).data;
}

export async function putResearchPortfolioGrant(
  api: AxiosInstance,
  id: string,
  principalId: string,
  input: Omit<PutResearchPortfolioGrantDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.put<ResearchPortfolioMutationReceiptDto>(
    `/api/research-portfolios/${id}/grants/${encodeURIComponent(principalId)}`,
    { ...input, idempotencyKey: newIdempotencyKey('grant') },
  )).data;
}

export async function removeResearchPortfolioGrant(
  api: AxiosInstance,
  id: string,
  principalId: string,
  expectedRevision: number,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.delete<ResearchPortfolioMutationReceiptDto>(
    `/api/research-portfolios/${id}/grants/${encodeURIComponent(principalId)}`,
    { data: { expectedRevision, idempotencyKey: newIdempotencyKey('grant-remove') } },
  )).data;
}

export async function linkResearchPortfolioClient(
  api: AxiosInstance,
  id: string,
  input: Omit<CreateResearchPortfolioClientLinkDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.post<ResearchPortfolioMutationReceiptDto>(`/api/research-portfolios/${id}/client-links`, {
    ...input,
    idempotencyKey: newIdempotencyKey('client-link'),
  })).data;
}

export async function unlinkResearchPortfolioClient(
  api: AxiosInstance,
  id: string,
  clientId: string,
  expectedRevision: number,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.delete<ResearchPortfolioMutationReceiptDto>(
    `/api/research-portfolios/${id}/client-links/${encodeURIComponent(clientId)}`,
    { data: { expectedRevision, idempotencyKey: newIdempotencyKey('client-unlink') } },
  )).data;
}

export async function addResearchPortfolioMember(
  api: AxiosInstance,
  id: string,
  input: Omit<CreateResearchPortfolioMemberDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.post<ResearchPortfolioMutationReceiptDto>(`/api/research-portfolios/${id}/members`, {
    ...input,
    idempotencyKey: newIdempotencyKey('member-add'),
  })).data;
}

export async function decideResearchPortfolioMember(
  api: AxiosInstance,
  id: string,
  input: Omit<DecideResearchPortfolioMembersDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.post<ResearchPortfolioMutationReceiptDto>(
    `/api/research-portfolios/${id}/members/decisions`,
    { ...input, idempotencyKey: newIdempotencyKey('member-decision') },
  )).data;
}

export async function resolveResearchPortfolioMember(
  api: AxiosInstance,
  id: string,
  memberId: string,
  input: Omit<ResolveResearchPortfolioMemberDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioMutationReceiptDto> {
  return (await api.post<ResearchPortfolioMutationReceiptDto>(
    `/api/research-portfolios/${id}/members/${encodeURIComponent(memberId)}/resolve`,
    { ...input, idempotencyKey: newIdempotencyKey('member-resolve') },
  )).data;
}

export async function listResearchPortfolioReviews(
  api: AxiosInstance,
  id: string,
  lane: 'mine' | 'team' | 'deferred' | 'resolved',
): Promise<readonly ResearchPortfolioReviewDto[]> {
  return (await api.get<readonly ResearchPortfolioReviewDto[]>(
    `/api/research-portfolios/${id}/reviews`,
    { params: { lane } },
  )).data;
}

export async function assignResearchPortfolioReview(
  api: AxiosInstance,
  id: string,
  reviewId: string,
  input: Omit<AssignResearchPortfolioReviewDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioReviewMutationReceiptDto> {
  return (await api.post<ResearchPortfolioReviewMutationReceiptDto>(
    `/api/research-portfolios/${id}/reviews/${reviewId}/assign`,
    { ...input, idempotencyKey: newIdempotencyKey('review-assign') },
  )).data;
}

export async function decideResearchPortfolioReview(
  api: AxiosInstance,
  id: string,
  reviewId: string,
  input: Omit<DecideResearchPortfolioReviewDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioReviewMutationReceiptDto> {
  return (await api.post<ResearchPortfolioReviewMutationReceiptDto>(
    `/api/research-portfolios/${id}/reviews/${reviewId}/decision`,
    { ...input, idempotencyKey: newIdempotencyKey('review-decision') },
  )).data;
}

export async function getResearchPortfolioAnnualReview(
  api: AxiosInstance,
  id: string,
): Promise<ResearchPortfolioAnnualReviewDto> {
  return (await api.get<ResearchPortfolioAnnualReviewDto>(`/api/research-portfolios/${id}/annual-review`)).data;
}

export async function reopenResearchPortfolioAnnualReview(
  api: AxiosInstance,
  id: string,
  input: Omit<ReopenResearchPortfolioAnnualReviewDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioReviewMutationReceiptDto> {
  return (await api.post<ResearchPortfolioReviewMutationReceiptDto>(
    `/api/research-portfolios/${id}/annual-review/reopen`,
    { ...input, idempotencyKey: newIdempotencyKey('annual-reopen') },
  )).data;
}

export async function createResearchPortfolioImport(
  api: AxiosInstance,
  id: string,
  input: Omit<CreateResearchPortfolioImportDto, 'operationKey'>,
): Promise<ResearchPortfolioImportJobDto> {
  return (await api.post<ResearchPortfolioImportJobDto>(`/api/research-portfolios/${id}/imports`, {
    ...input,
    operationKey: newIdempotencyKey('import-create'),
  })).data;
}

export async function getResearchPortfolioImport(
  api: AxiosInstance,
  id: string,
  jobId: string,
): Promise<ResearchPortfolioImportDetailDto> {
  return (await api.get<ResearchPortfolioImportDetailDto>(`/api/research-portfolios/${id}/imports/${jobId}`)).data;
}

export async function actOnResearchPortfolioImport(
  api: AxiosInstance,
  id: string,
  jobId: string,
  action: 'preview' | 'apply' | 'pause' | 'resume' | 'cancel' | 'retry' | 'reconcile' | 'compensate',
  input: Omit<ResearchPortfolioImportActionDto, 'operationKey'> = {},
): Promise<ResearchPortfolioImportDetailDto> {
  return (await api.post<ResearchPortfolioImportDetailDto>(
    `/api/research-portfolios/${id}/imports/${jobId}/${action}`,
    { ...input, operationKey: newIdempotencyKey(`import-${action}`) },
  )).data;
}

export async function listResearchPortfolioChanges(
  api: AxiosInstance,
  id: string,
  cursor?: string | null,
  limit = 50,
): Promise<ResearchPortfolioChangesResponse> {
  return (await api.get<ResearchPortfolioChangesResponse>(`/api/research-portfolios/${id}/changes`, {
    params: { ...(cursor ? { cursor } : {}), limit },
  })).data;
}

export async function updateResearchPortfolioChangeState(
  api: AxiosInstance,
  id: string,
  eventId: string,
  input: UpdateResearchPortfolioEventStateDto,
): Promise<ResearchPortfolioEventRecipientStateDto> {
  return (await api.patch<ResearchPortfolioEventRecipientStateDto>(
    `/api/research-portfolios/${id}/changes/${encodeURIComponent(eventId)}/state`,
    input,
  )).data;
}

export async function listResearchPortfolioSubscriptions(
  api: AxiosInstance,
  id: string,
): Promise<readonly ResearchPortfolioSubscriptionDto[]> {
  return (await api.get<readonly ResearchPortfolioSubscriptionDto[]>(
    `/api/research-portfolios/${id}/subscriptions`,
  )).data;
}

export async function createResearchPortfolioSubscription(
  api: AxiosInstance,
  id: string,
  input: CreateResearchPortfolioSubscriptionDto,
): Promise<ResearchPortfolioSubscriptionDto> {
  return (await api.post<ResearchPortfolioSubscriptionDto>(
    `/api/research-portfolios/${id}/subscriptions`,
    input,
  )).data;
}

export async function updateResearchPortfolioSubscription(
  api: AxiosInstance,
  id: string,
  subscriptionId: string,
  input: UpdateResearchPortfolioSubscriptionDto,
): Promise<ResearchPortfolioSubscriptionDto> {
  return (await api.patch<ResearchPortfolioSubscriptionDto>(
    `/api/research-portfolios/${id}/subscriptions/${encodeURIComponent(subscriptionId)}`,
    input,
  )).data;
}

export async function getResearchPortfolioAnalytics(
  api: AxiosInstance,
  id: string,
): Promise<ResearchPortfolioAnalyticsDto> {
  return (await api.get<ResearchPortfolioAnalyticsDto>(`/api/research-portfolios/${id}/analytics`)).data;
}

export async function listResearchPortfolioSnapshots(
  api: AxiosInstance,
  id: string,
): Promise<readonly ResearchPortfolioSnapshotSummaryDto[]> {
  return (await api.get<readonly ResearchPortfolioSnapshotSummaryDto[]>(
    `/api/research-portfolios/${id}/snapshots`,
  )).data;
}

export async function createResearchPortfolioSnapshot(
  api: AxiosInstance,
  id: string,
  input: Omit<CreateResearchPortfolioSnapshotDto, 'operationKey'>,
): Promise<ResearchPortfolioSnapshotDto> {
  return (await api.post<ResearchPortfolioSnapshotDto>(`/api/research-portfolios/${id}/snapshots`, {
    ...input,
    operationKey: newIdempotencyKey('snapshot-create'),
  })).data;
}

export async function getResearchPortfolioSnapshot(
  api: AxiosInstance,
  id: string,
  snapshotId: string,
): Promise<ResearchPortfolioSnapshotDto> {
  return (await api.get<ResearchPortfolioSnapshotDto>(
    `/api/research-portfolios/${id}/snapshots/${encodeURIComponent(snapshotId)}`,
  )).data;
}

export async function createResearchPortfolioOutput(
  api: AxiosInstance,
  id: string,
  input: Omit<CreateResearchPortfolioOutputDto, 'operationKey'>,
): Promise<ResearchPortfolioOutputJobDto> {
  return (await api.post<ResearchPortfolioOutputJobDto>(`/api/research-portfolios/${id}/outputs`, {
    ...input,
    operationKey: newIdempotencyKey('output-create'),
  })).data;
}

export async function getResearchPortfolioOutputJob(
  api: AxiosInstance,
  id: string,
  jobId: string,
): Promise<ResearchPortfolioOutputJobDto> {
  return (await api.get<ResearchPortfolioOutputJobDto>(
    `/api/research-portfolios/${id}/output-jobs/${encodeURIComponent(jobId)}`,
  )).data;
}

export async function actOnResearchPortfolioOutput(
  api: AxiosInstance,
  id: string,
  jobId: string,
  action: 'cancel' | 'retry' | 'reconcile',
): Promise<ResearchPortfolioOutputJobDto> {
  return (await api.post<ResearchPortfolioOutputJobDto>(
    `/api/research-portfolios/${id}/output-jobs/${encodeURIComponent(jobId)}/${action}`,
  )).data;
}

export async function downloadResearchPortfolioOutput(
  api: AxiosInstance,
  id: string,
  artifact: ResearchPortfolioOutputArtifactDto,
): Promise<Blob> {
  const response = await api.get<Blob>(
    `/api/research-portfolios/${id}/outputs/${encodeURIComponent(artifact.id)}/download`,
    { responseType: 'blob' },
  );
  return response.data;
}

export async function saveResearchPortfolioOutputToClient(
  api: AxiosInstance,
  id: string,
  outputId: string,
  input: Omit<SaveResearchPortfolioOutputToClientDto, 'operationKey'>,
): Promise<ResearchPortfolioClientFileReceiptDto> {
  return (await api.post<ResearchPortfolioClientFileReceiptDto>(
    `/api/research-portfolios/${id}/outputs/${encodeURIComponent(outputId)}/client-files`,
    { ...input, operationKey: newIdempotencyKey('output-client-file') },
  )).data;
}

// --- Phase 11: bookmarks, fit, review notes, watch-conversion, operations, tour ---

import type {
  ResearchPortfolioBookmarkDto,
  CreateResearchPortfolioBookmarkDto,
  UpdateResearchPortfolioBookmarkDto,
  ResearchPortfolioFitDto,
  ResearchPortfolioReviewNoteDto,
  ResearchPortfolioWatchConversionPreviewDto,
  ResearchPortfolioWatchConversionResultDto,
  ResearchPortfolioOperationDto,
  ResearchPortfolioTourStateDto,
} from '@capiro/shared';

export async function listResearchPortfolioBookmarks(api: AxiosInstance, id: string): Promise<readonly ResearchPortfolioBookmarkDto[]> {
  return (await api.get<readonly ResearchPortfolioBookmarkDto[]>(`/api/research-portfolios/${id}/bookmarks`)).data;
}

export async function createResearchPortfolioBookmark(
  api: AxiosInstance, id: string, input: Omit<CreateResearchPortfolioBookmarkDto, 'idempotencyKey'>,
): Promise<ResearchPortfolioBookmarkDto> {
  return (await api.post<ResearchPortfolioBookmarkDto>(`/api/research-portfolios/${id}/bookmarks`, { ...input, idempotencyKey: newIdempotencyKey('bookmark') })).data;
}

export async function updateResearchPortfolioBookmark(
  api: AxiosInstance, id: string, bookmarkId: string, input: UpdateResearchPortfolioBookmarkDto,
): Promise<ResearchPortfolioBookmarkDto> {
  return (await api.patch<ResearchPortfolioBookmarkDto>(`/api/research-portfolios/${id}/bookmarks/${bookmarkId}`, input)).data;
}

export async function deleteResearchPortfolioBookmark(api: AxiosInstance, id: string, bookmarkId: string): Promise<void> {
  await api.delete(`/api/research-portfolios/${id}/bookmarks/${bookmarkId}`);
}

export async function getResearchPortfolioFit(api: AxiosInstance, id: string): Promise<ResearchPortfolioFitDto> {
  return (await api.get<ResearchPortfolioFitDto>(`/api/research-portfolios/${id}/fit`)).data;
}

export async function refreshResearchPortfolioFit(api: AxiosInstance, id: string): Promise<ResearchPortfolioFitDto> {
  return (await api.post<ResearchPortfolioFitDto>(`/api/research-portfolios/${id}/fit/refresh`)).data;
}

export async function addResearchPortfolioReviewNote(
  api: AxiosInstance, id: string, reviewId: string, body: string, expectedRevision: number,
): Promise<ResearchPortfolioReviewNoteDto> {
  return (await api.post<ResearchPortfolioReviewNoteDto>(`/api/research-portfolios/${id}/reviews/${reviewId}/notes`, { body, expectedRevision, idempotencyKey: newIdempotencyKey('review-note') })).data;
}

export async function previewResearchPortfolioWatchConversion(api: AxiosInstance, id: string): Promise<ResearchPortfolioWatchConversionPreviewDto> {
  return (await api.post<ResearchPortfolioWatchConversionPreviewDto>(`/api/research-portfolios/${id}/watch-conversion/preview`)).data;
}

export async function applyResearchPortfolioWatchConversion(api: AxiosInstance, id: string): Promise<ResearchPortfolioWatchConversionResultDto> {
  return (await api.post<ResearchPortfolioWatchConversionResultDto>(`/api/research-portfolios/${id}/watch-conversion/apply`)).data;
}

export async function getResearchPortfolioOperation(api: AxiosInstance, id: string, operationId: string): Promise<ResearchPortfolioOperationDto> {
  return (await api.get<ResearchPortfolioOperationDto>(`/api/research-portfolios/${id}/operations/${operationId}`)).data;
}

export async function reconcileResearchPortfolioOperation(api: AxiosInstance, id: string, operationId: string): Promise<ResearchPortfolioOperationDto> {
  return (await api.post<ResearchPortfolioOperationDto>(`/api/research-portfolios/${id}/operations/${operationId}/reconcile`)).data;
}

export async function getResearchPortfolioTourState(api: AxiosInstance, tourVersion: string): Promise<ResearchPortfolioTourStateDto> {
  return (await api.get<ResearchPortfolioTourStateDto>(`/api/research-portfolios/tour-state/${encodeURIComponent(tourVersion)}`)).data;
}

export async function updateResearchPortfolioTourState(api: AxiosInstance, tourVersion: string, status: 'dismissed' | 'completed'): Promise<ResearchPortfolioTourStateDto> {
  return (await api.post<ResearchPortfolioTourStateDto>(`/api/research-portfolios/tour-state/${encodeURIComponent(tourVersion)}`, { status })).data;
}
