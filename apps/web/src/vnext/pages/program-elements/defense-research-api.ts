import type { AxiosInstance } from 'axios';
import type {
  DefenseOfficeDetailDto,
  DefenseOfficeListDto,
  DefenseRelationshipListDto,
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
