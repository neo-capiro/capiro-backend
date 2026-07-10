import type { AxiosInstance } from 'axios';

/**
 * District Impact Engine (Phase 1 M1.4) — "who represents your footprint".
 * Mirrors apps/api/src/clients/representation.controller.ts
 * (GET /api/clients/:clientId/representation → RepresentationResolverService
 * .representationForClient). Deterministic — never an LLM guess (PD2).
 */

export interface FederalMemberSummary {
  bioguideId: string;
  fullName: string;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string;
}
export interface StateLegislatorSummary {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  district: string | null;
  party: string | null;
  /** OpenStates profile — no in-app directory profile exists for state legislators yet. */
  url: string | null;
}
export interface ResolvedRepresentation {
  unresolved: false;
  federal: { house: FederalMemberSummary | null; senate: FederalMemberSummary[] };
  state: { lower: StateLegislatorSummary | null; upper: StateLegislatorSummary | null };
}
export interface UnresolvedRepresentation {
  unresolved: true;
  reason: 'no_geocode' | 'no_state';
}
export type RepresentationResult = ResolvedRepresentation | UnresolvedRepresentation;

export interface FacilityRepresentation {
  facility: { id: string; name: string; city: string | null; state: string | null };
  representation: RepresentationResult;
}

export async function getClientRepresentation(
  api: AxiosInstance,
  clientId: string,
): Promise<FacilityRepresentation[]> {
  return (
    await api.get<FacilityRepresentation[]>(
      `/api/clients/${encodeURIComponent(clientId)}/representation`,
    )
  ).data;
}
