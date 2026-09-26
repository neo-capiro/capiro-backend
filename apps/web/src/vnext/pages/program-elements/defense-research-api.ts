import type { AxiosInstance } from 'axios';
import type {
  DefenseOfficeDetailDto,
  DefenseOfficeListDto,
  DefenseRelationshipListDto,
  DefenseAcquisitionRecordListDto,
  DefenseAcquisitionRecordDetailDto,
  DefenseAcquisitionRecordActionDto,
  DefenseAcquisitionCoverageGapListDto,
  DefenseSearchResponseDto,
  DefenseComparisonResponseDto,
  DefenseProductCoverageResponseDto,
} from '@capiro/shared';

export interface OfficeFilters {
  agency?: string;
  component?: string;
  officeType?: string;
  capability?: string;
  program?: string;
  status?: string;
  availability?: string;
  freshness?: string;
  q?: string;
  page?: number;
  limit?: number;
}

export interface RelationshipFilters {
  from?: string;
  to?: string;
  edgeType?: string;
  status?: string;
  includeSpeculative?: boolean;
  page?: number;
  limit?: number;
}

export interface AcquisitionFilters {
  q?: string;
  sourceSystem?: string;
  recordKind?: string;
  status?: string;
  buyerOffice?: string;
  activeOn?: string;
  page?: number;
  limit?: number;
}

function defined<T extends Record<string, unknown>>(values: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== ''),
  );
}

export async function listDefenseOffices(api: AxiosInstance, filters: OfficeFilters) {
  return (
    await api.get<DefenseOfficeListDto>('/api/defense-budget/offices', {
      params: defined(filters as Record<string, unknown>),
    })
  ).data;
}

export async function getDefenseOffice(api: AxiosInstance, officeId: string) {
  return (
    await api.get<DefenseOfficeDetailDto>(
      `/api/defense-budget/offices/${encodeURIComponent(officeId)}`,
    )
  ).data;
}

export async function listDefenseRelationships(
  api: AxiosInstance,
  filters: RelationshipFilters,
) {
  return (
    await api.get<DefenseRelationshipListDto>('/api/defense-budget/relationships', {
      params: defined(filters as Record<string, unknown>),
    })
  ).data;
}

export async function listAcquisitionRecords(api: AxiosInstance, filters: AcquisitionFilters) {
  return (await api.get<DefenseAcquisitionRecordListDto>('/api/defense-budget/acquisition-records', {
    params: defined(filters as Record<string, unknown>),
  })).data;
}

export async function getAcquisitionRecord(api: AxiosInstance, identityKey: string) {
  return (await api.get<DefenseAcquisitionRecordDetailDto>(
    `/api/defense-budget/acquisition-records/${encodeURIComponent(identityKey)}`,
    { params: { includeSpeculative: false } },
  )).data;
}

export async function getAcquisitionActions(api: AxiosInstance, identityKey: string) {
  return (await api.get<readonly DefenseAcquisitionRecordActionDto[]>(
    `/api/defense-budget/acquisition-records/${encodeURIComponent(identityKey)}/actions`,
  )).data;
}

export async function getAcquisitionCoverage(api: AxiosInstance, subjectKind: string, subjectKey: string) {
  return (await api.get<DefenseAcquisitionCoverageGapListDto>('/api/defense-budget/acquisition-coverage', {
    params: { subjectKind, subjectKey },
  })).data;
}

export interface DefenseSearchFilters {
  q: string;
  semanticEnabled?: boolean;
}

export async function searchDefenseBudget(
  api: AxiosInstance,
  filters: DefenseSearchFilters,
) {
  return (
    await api.get<DefenseSearchResponseDto>('/api/defense-budget/search', {
      params: defined({ ...filters }),
    })
  ).data;
}

export interface DefenseCompareFilters {
  subjects: readonly string[];
}

export async function compareDefenseBudget(
  api: AxiosInstance,
  filters: DefenseCompareFilters,
) {
  return (
    await api.get<DefenseComparisonResponseDto>('/api/defense-budget/compare', {
      params: { subjects: filters.subjects.join(',') },
    })
  ).data;
}

export interface DefenseProductCoverageFilters {
  perimeter?: string;
  component?: string;
  account?: string;
  family?: string;
  fiscalYear?: number;
  edition?: string;
  stage?: string;
  detail?: string;
}

export async function getDefenseProductCoverage(
  api: AxiosInstance,
  filters: DefenseProductCoverageFilters,
) {
  return (
    await api.get<DefenseProductCoverageResponseDto>('/api/defense-budget/product-coverage', {
      params: defined(filters as Record<string, unknown>),
    })
  ).data;
}
