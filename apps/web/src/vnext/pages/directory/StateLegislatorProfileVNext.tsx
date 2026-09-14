import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { stateBillStatusLabel } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { getStateLegislatorDetail } from '../../../pages/directory/directory-api.js';
import type { StateLegislatorDetail } from '../../../pages/directory/StateLegislatorDirectory.js';
import {
  NOT_PROVIDED,
  chamberLabel,
  orNotProvided,
} from '../../../pages/directory/directory-profile-shared.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import {
  ProfileBackLink,
  ProfileCard,
  ProfileErrorState,
  ProfileHero,
  ProfileLoading,
  ProfilePage,
} from './profile-primitives.js';

/**
 * State-legislator profile page — Directory vNext
 * (`/directory/state-legislators/:id`, OpenStates "ocd-person/…" ids).
 *
 * Re-skin of the canonical `StateLegislatorProfilePage` +
 * `StateLegislatorProfileView`: same `/api/explorer/state-legislators/:id`
 * resource, same `['state-legislator-detail-page', id]` query key. Unlike the
 * member/staff profiles, this surface deliberately SHOWS "Not provided by
 * source" placeholders in the Contact grid (canonical behaviour), and it
 * never collapses `sponsoredBills: null` (never crosswalked to LegiScan) into
 * an empty list — that would fabricate a "sponsors nothing" claim.
 */

export function StateLegislatorProfileViewVNext({
  legislator,
}: {
  legislator: StateLegislatorDetail;
}) {
  const [searchParams] = useSearchParams();
  const billScope = new URLSearchParams();
  for (const key of ['client', 'folder']) {
    const value = searchParams.get(key);
    if (value) billScope.set(key, value);
  }
  const districtLine = [
    legislator.state,
    chamberLabel(legislator.chamber),
    legislator.district ? `District ${legislator.district}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const bills = legislator.sponsoredBills;

  return (
    <article className="capiro-dirpage__profile" data-testid="state-legislator-profile">
      <ProfileHero name={legislator.name} photoUrl={legislator.image}>
        <p className="capiro-dirprofile__meta">{orNotProvided(districtLine || null)}</p>
        <div className="capiro-dirprofile__pills">
          {legislator.party ? <CapiroBadge>{legislator.party}</CapiroBadge> : null}
          <CapiroBadge tone={legislator.active ? 'success' : 'neutral'}>
            {legislator.active ? 'Active' : 'Inactive'}
          </CapiroBadge>
        </div>
        <p className="capiro-dirprofile__meta">Synced {orNotProvided(legislator.syncedAt)}</p>
      </ProfileHero>

      <ProfileCard title="Contact">
        <dl className="capiro-dirpage__desc">
          <div className="capiro-dirpage__desc-item">
            <dt>Email</dt>
            <dd>
              {legislator.email ? (
                <a className="capiro-dirprofile__link" href={`mailto:${legislator.email}`}>
                  {legislator.email}
                </a>
              ) : (
                NOT_PROVIDED
              )}
            </dd>
          </div>
          <div className="capiro-dirpage__desc-item">
            <dt>Website</dt>
            <dd>
              {legislator.url ? (
                <a
                  className="capiro-dirprofile__link"
                  href={legislator.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {legislator.url}
                </a>
              ) : (
                NOT_PROVIDED
              )}
            </dd>
          </div>
          <div className="capiro-dirpage__desc-item">
            <dt>State</dt>
            <dd>{orNotProvided(legislator.state)}</dd>
          </div>
          <div className="capiro-dirpage__desc-item">
            <dt>Chamber</dt>
            <dd>{orNotProvided(chamberLabel(legislator.chamber))}</dd>
          </div>
          <div className="capiro-dirpage__desc-item">
            <dt>District</dt>
            <dd>{orNotProvided(legislator.district)}</dd>
          </div>
          <div className="capiro-dirpage__desc-item">
            <dt>Party</dt>
            <dd>{orNotProvided(legislator.party)}</dd>
          </div>
        </dl>
      </ProfileCard>

      <ProfileCard title={`Committees (${legislator.committees.length})`}>
        {legislator.committees.length === 0 ? (
          <p className="capiro-dirprofile__meta">{NOT_PROVIDED}</p>
        ) : (
          <div className="capiro-dirpage__rows">
            {legislator.committees.map((c) => (
              <div key={c.id} className="capiro-dirpage__row">
                <span className="capiro-dirpage__row-title">{orNotProvided(c.name)}</span>{' '}
                {c.role ? <CapiroBadge>{c.role}</CapiroBadge> : null}
                {c.chamber ? (
                  <span className="capiro-dirprofile__meta"> · {chamberLabel(c.chamber)}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </ProfileCard>

      <ProfileCard title={`Sponsored bills${bills ? ` (${legislator.sponsoredBillsTotal})` : ''}`}>
        {bills === null ? (
          // null (not []) = never crosswalked to LegiScan; do NOT claim "sponsors nothing".
          <p className="capiro-dirprofile__meta">
            Bill sponsorship data not available for this legislator
          </p>
        ) : bills.length === 0 ? (
          <CapiroEmptyState title="No sponsored bills on record" />
        ) : (
          <div className="capiro-dirpage__rows">
            {bills.map((b) => (
              <div key={b.billId} className="capiro-dirpage__row">
                <Link
                  className="capiro-dirpage__row-title capiro-dirprofile__link"
                  to={`/bills/${encodeURIComponent(b.billId)}${billScope.size ? `?${billScope}` : ''}`}
                  aria-label={`Open Bill 360 for ${orNotProvided(b.identifier)}`}
                >
                  {orNotProvided(b.identifier)}
                </Link>{' '}
                <span className="capiro-dirprofile__line">{orNotProvided(b.title)}</span>{' '}
                {b.status ? <CapiroBadge>{stateBillStatusLabel(b.status)}</CapiroBadge> : null}
                {b.sponsorType ? (
                  <span className="capiro-dirprofile__meta"> · {b.sponsorType}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </ProfileCard>
    </article>
  );
}

export function StateLegislatorProfileVNext({ id }: { id: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['state-legislator-detail-page', id],
    queryFn: () => getStateLegislatorDetail(api, id),
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <ProfilePage>
      <ProfileBackLink navigate={navigate} />
      {query.isLoading ? (
        <ProfileLoading />
      ) : query.isError || !query.data ? (
        <ProfileErrorState
          title="State legislator profile unavailable"
          description="This legislator could not be found."
        />
      ) : (
        <StateLegislatorProfileViewVNext legislator={query.data} />
      )}
    </ProfilePage>
  );
}
