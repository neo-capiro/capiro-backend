import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { AxiosInstance } from 'axios';
import { useApi } from '../../../lib/use-api.js';
import { districtKmlUrl, getDistrict } from '../../../pages/directory/directory-api.js';
import type { DirectoryDistrictDetail } from '../../../pages/directory/directory-api.js';
import { parseKmlToSvgPaths } from '../../../pages/directory/district-kml.js';
import { districtLabel, orNotProvided } from '../../../pages/directory/directory-profile-shared.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import {
  ProfileBackLink,
  ProfileCard,
  ProfileDescriptions,
  ProfileErrorState,
  ProfileLoading,
  ProfilePage,
} from './profile-primitives.js';

/**
 * House-district detail page — Directory vNext
 * (`/directory/districts/:state/:districtNo`).
 *
 * Re-skin of the canonical `DistrictDetailPage` + `DistrictDetailView` +
 * `DistrictBoundaryPreview`: same `/api/directory/districts/:state/:no`
 * resource under the same `['district-detail', …]` key, same 'C'/'F'
 * two-resource semantics (a 404 on the 'F' side means "no pending map", not
 * an error), and the same dependency-free KML→SVG silhouette via
 * `district-kml.ts` under the same `['district-kml', …]` key — only the
 * silhouette's color moves from a hardcoded hex to the token layer.
 */

/**
 * Static shape preview for a district boundary — no basemap, no pan/zoom,
 * just the silhouette. `hasBoundary` gates whether we even attempt the fetch
 * (WS-B's --with-kml is opt-in, so most districts have none yet).
 */
export function DistrictBoundaryPreviewVNext({
  api,
  state,
  districtNo,
  status,
  hasBoundary,
}: {
  api: AxiosInstance;
  state: string;
  districtNo: string;
  status: 'C' | 'F';
  hasBoundary: boolean;
}) {
  const query = useQuery({
    queryKey: ['district-kml', state, districtNo, status],
    queryFn: async () => {
      const { data } = await api.get<string>(districtKmlUrl(state, districtNo, status), {
        responseType: 'text',
      });
      return parseKmlToSvgPaths(data);
    },
    enabled: hasBoundary,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  if (!hasBoundary) {
    return <CapiroEmptyState title="Boundary not yet fetched for this district" />;
  }
  if (query.isLoading) return <CapiroSkeleton height={180} />;
  if (query.isError || !query.data) {
    return (
      <CapiroErrorState
        title="Boundary unavailable"
        description="The stored boundary could not be loaded."
      />
    );
  }

  const { paths, viewBox } = query.data;
  return (
    <svg
      viewBox={viewBox}
      className="capiro-dirpage-boundary"
      aria-label={`${state} district ${districtNo} boundary`}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} fillRule="evenodd" />
      ))}
    </svg>
  );
}

export function DistrictDetailViewVNext({
  district,
  api,
}: {
  district: DirectoryDistrictDetail;
  api: AxiosInstance;
}) {
  return (
    <article className="capiro-dirpage__profile" data-testid="district-detail">
      <header className="capiro-dirpage__hero">
        <IdentityMark kind="office" size="lg" name={districtLabel(district)} aria-hidden="true" />
        <div className="capiro-dirpage__hero-main">
          <h1 className="capiro-dirpage__title">{districtLabel(district)}</h1>
          <p className="capiro-dirprofile__meta">{orNotProvided(district.name)}</p>
          <div className="capiro-dirprofile__pills">
            <CapiroBadge tone={district.status === 'C' ? 'success' : 'warning'}>
              {district.status === 'C' ? 'Current map' : 'Enacted (future) map'}
            </CapiroBadge>
          </div>
          <p className="capiro-dirprofile__meta">Synced {orNotProvided(district.syncedAt)}</p>
        </div>
      </header>

      <ProfileDescriptions
        title="Redistricting"
        fields={[
          { label: 'Enacted date', value: orNotProvided(district.enactedDate) },
          { label: 'Effective date', value: orNotProvided(district.effectiveDate) },
        ]}
      />

      <ProfileCard
        title={`Current representative${district.currentMembers.length === 1 ? '' : 's'} (${district.currentMembers.length})`}
      >
        {district.currentMembers.length === 0 ? (
          <CapiroEmptyState title="No current representative on record" />
        ) : (
          <div className="capiro-dirpage__rows">
            {district.currentMembers.map((m) => (
              <div key={m.id} className="capiro-dirpage-roster__row">
                <IdentityMark
                  kind="person"
                  size="md"
                  name={m.fullName}
                  imageUrl={m.photoUrl}
                  aria-hidden="true"
                />
                <div className="capiro-dirpage-roster__main">
                  <Link
                    className="capiro-dirprofile__link capiro-dirpage-roster__name"
                    to={`/directory/members/${encodeURIComponent(m.id)}`}
                  >
                    {m.fullName}
                  </Link>
                  <div className="capiro-dirpage-roster__meta">
                    {m.partyName ? <CapiroBadge>{m.partyName}</CapiroBadge> : null}
                    <CapiroBadge tone="info">{m.chamber}</CapiroBadge>
                  </div>
                  {m.outgoingStatus ? (
                    <p className="capiro-dirprofile__meta">{m.outgoingStatus}</p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </ProfileCard>

      <ProfileCard title="Boundary">
        <DistrictBoundaryPreviewVNext
          api={api}
          state={district.state}
          districtNo={district.districtNo}
          status={district.status}
          hasBoundary={district.hasBoundary}
        />
      </ProfileCard>
    </article>
  );
}

export function DistrictProfileVNext({
  state,
  districtNo,
}: {
  state: string;
  districtNo: string;
}) {
  const [status, setStatus] = useState<'C' | 'F'>('C');
  const api = useApi();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['district-detail', state, districtNo, status],
    queryFn: () => getDistrict(api, state, districtNo, status),
    enabled: Boolean(state && districtNo),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // A district doesn't necessarily have BOTH a current and a future/enacted
  // row at any given time — only during a live redistricting cycle. A 404
  // on the 'F' side just means "no pending map," not an error.
  const noFutureMap = status === 'F' && query.isError;

  return (
    <ProfilePage>
      <ProfileBackLink navigate={navigate} />
      <div className="capiro-dirpage-segmented" role="group" aria-label="District map version">
        {(
          [
            { label: 'Current map', value: 'C' },
            { label: 'Enacted (future) map', value: 'F' },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            data-selected={status === option.value || undefined}
            aria-pressed={status === option.value}
            onClick={() => setStatus(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {query.isLoading ? (
        <ProfileLoading />
      ) : noFutureMap ? (
        <CapiroEmptyState title="No pending redistricting map on record for this district" />
      ) : query.isError || !query.data ? (
        <ProfileErrorState title="District not found" description="This district could not be found." />
      ) : (
        <DistrictDetailViewVNext district={query.data} api={api} />
      )}
    </ProfilePage>
  );
}
