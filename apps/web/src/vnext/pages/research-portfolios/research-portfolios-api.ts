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
} from '@capiro/shared';

export const researchPortfolioKeys = {
  all: ['research-portfolios'] as const,
  detail: (id: string) => ['research-portfolios', id] as const,
};

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
