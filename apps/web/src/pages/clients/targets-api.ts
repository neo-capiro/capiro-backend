import type { AxiosInstance } from 'axios';

/**
 * Web API for Client Targets (CRUD) + Office Recommender (Meri suggestions).
 *
 * Mirrors apps/api/src/clients/client-targets.controller.ts (mounted at
 * /api/clients/:clientId/targets) and the office recommender surfaced inside the
 * client profile-v1 aggregate (relationships.officeRecommender).
 *
 * member_id is the congressional directory member id (DirectoryEntry.id /
 * bioguide) — the directory is an in-memory S3 snapshot, not a DB table, so the
 * row denormalizes a compact member snapshot at add time.
 */

export type TargetSource = 'manual' | 'meri';

/** 'congress' (member) | 'staff' (congressional staffer) | 'state' (OpenStates legislator). */
export type TargetDirectory = 'congress' | 'state' | 'staff';

/** Engagement priority tier (1 = highest .. 3); null = untiered. */
export type TargetTier = 1 | 2 | 3 | null;

export interface ClientTarget {
  id: string;
  clientId: string;
  memberId: string;
  memberName: string | null;
  /** Which directory the target came from — drives profile click-through. */
  sourceDirectory: TargetDirectory;
  /** Single char ('R'/'D'/'I') for congress; full word ("Democrat") for state. */
  party: string | null;
  /** Senate: "TX"; House: "TX-12"; state: "CA" or "CA-12". */
  state: string | null;
  /** "House"/"Senate" (congress) or "upper"/"lower" (state). */
  chamber: string | null;
  committee: string | null;
  /** Engagement priority tier (1..3) or null (untiered). */
  tier: TargetTier;
  source: TargetSource;
  addedByUserId: string | null;
  addedAt: string;
  /**
   * WS-E, LegiStorm gaps/enrichment plan — resolved FRESH server-side from
   * the member's CURRENT district (never from this row's own denormalized
   * `state` snapshot text, which goes stale after a redistricting or a seat
   * change). `null` means "not applicable" (a staff target) or "member
   * couldn't be resolved in current data" (e.g. they've left office) —
   * distinct from an empty array, which means "resolved, represents none of
   * this client's facilities".
   */
  representedFacilities: RepresentedFacility[] | null;
}

export interface RepresentedFacility {
  id: string;
  name: string;
}

/** A single Meri office recommendation. */
export interface OfficeRecommendation {
  memberId: string;
  office: string;
  party: 'R' | 'D' | 'I' | null;
  state: string | null;
  chamber: 'House' | 'Senate' | null;
  committee: string | null;
  score: number;
  tags: string[];
  billCount: number;
}

/**
 * Persisted office-recommendations payload from
 * /api/clients/:clientId/target-recommendations. Computing them is slow, so the
 * server caches the result and serves it instantly on subsequent loads;
 * `computedAt` is when this set was produced (null only if never computed).
 */
export interface OfficeRecommendationsResult {
  recommendations: OfficeRecommendation[];
  computedAt: string | null;
}

/**
 * Read the cached office recommendations. The server computes-and-persists on the
 * first ever request for a client (a few seconds), then serves the cache.
 */
export async function getOfficeRecommendations(
  api: AxiosInstance,
  clientId: string,
): Promise<OfficeRecommendationsResult> {
  return (
    await api.get<OfficeRecommendationsResult>(
      `/api/clients/${encodeURIComponent(clientId)}/target-recommendations`,
    )
  ).data;
}

/** Force a recompute of the office recommendations and overwrite the cache. */
export async function refreshOfficeRecommendations(
  api: AxiosInstance,
  clientId: string,
): Promise<OfficeRecommendationsResult> {
  return (
    await api.post<OfficeRecommendationsResult>(
      `/api/clients/${encodeURIComponent(clientId)}/target-recommendations/refresh`,
    )
  ).data;
}

export async function getClientTargets(
  api: AxiosInstance,
  clientId: string,
): Promise<ClientTarget[]> {
  return (
    await api.get<ClientTarget[]>(`/api/clients/${encodeURIComponent(clientId)}/targets`)
  ).data;
}

export async function addClientTarget(
  api: AxiosInstance,
  clientId: string,
  memberId: string,
  source: TargetSource,
  sourceDirectory: TargetDirectory = 'congress',
): Promise<ClientTarget> {
  return (
    await api.post<ClientTarget>(`/api/clients/${encodeURIComponent(clientId)}/targets`, {
      memberId,
      source,
      sourceDirectory,
    })
  ).data;
}

// memberId is sent as a QUERY param, not a path segment: OpenStates ids contain a
// slash ("ocd-person/…") which proxies can normalize and mis-route in a path.
export async function removeClientTarget(
  api: AxiosInstance,
  clientId: string,
  memberId: string,
): Promise<{ deleted: true }> {
  return (
    await api.delete<{ deleted: true }>(
      `/api/clients/${encodeURIComponent(clientId)}/targets`,
      { params: { memberId } },
    )
  ).data;
}

/** Assign (tier 1..3) or clear (tier null) a target's engagement tier. */
export async function setClientTargetTier(
  api: AxiosInstance,
  clientId: string,
  memberId: string,
  tier: TargetTier,
): Promise<ClientTarget> {
  return (
    await api.patch<ClientTarget>(`/api/clients/${encodeURIComponent(clientId)}/targets/tier`, {
      memberId,
      tier,
    })
  ).data;
}
