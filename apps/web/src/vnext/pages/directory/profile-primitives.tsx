import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NavigateFunction } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getContactTrips } from '../../../pages/directory/directory-api.js';
import type { DirectoryContactTripSummary } from '../../../pages/directory/directory-api.js';
import { hasText, historyCanGoBack, usd } from '../../../pages/directory/directory-profile-shared.js';
import type { OfficeAddress } from '../../../pages/directory/directory-profile-shared.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark, type IdentityKind } from '../../components/identity/index.js';
import './directory.css';

/**
 * Shared building blocks for the deep-linkable directory profile pages —
 * Directory vNext (Phase 2 old-UI purge).
 *
 * These are the vNext re-skins of `pages/directory/directory-profile-helpers.tsx`
 * (DescriptionsCard/ListCard/renderOfficeAddress), `ProfileBackLink.tsx` and
 * `ContactTripsSection.tsx`: identical data behaviour — the same
 * "hide-empty-fields, vanish-when-empty" directory rules, the same query keys
 * and endpoints — with presentation moved to the kit primitives
 * (`vnext/components/**`) and `--capiro-*` tokens. Pure logic (hasText,
 * usd, historyCanGoBack, …) is shared with the canonical pages via
 * `directory-profile-shared.ts`, so the two surfaces cannot drift on what the
 * data means.
 */

/* ── Page scaffold ───────────────────────────────────────────────────────── */

/** Centered 960px column, matching the canonical profile pages' footprint. */
export function ProfilePage({ children }: { children: ReactNode }) {
  return <div className="capiro-dirpage">{children}</div>;
}

/**
 * Context-aware "back" for the deep-linkable profile pages. Returns to
 * wherever the user came from (the client Targets tab, the directory, a
 * committee page, …) via browser history, falling back to a fixed destination
 * only on a cold deep-link — the exact decision canonical's ProfileBackLink
 * makes, via the shared historyCanGoBack().
 */
export function ProfileBackLink({
  navigate,
  fallback = '/directory',
  label = '← Back',
}: {
  navigate: NavigateFunction;
  fallback?: string;
  label?: string;
}) {
  const onBack = () => {
    if (historyCanGoBack()) navigate(-1);
    else navigate(fallback);
  };
  return (
    <button
      type="button"
      className="capiro-dirpage__back"
      onClick={onBack}
      data-testid="profile-back-link"
    >
      {label}
    </button>
  );
}

/** Loading scaffold: skeletons in the shape of the hero + two cards. */
export function ProfileLoading() {
  return (
    <div className="capiro-dirpage__loading" aria-busy="true" aria-label="Loading profile">
      <CapiroSkeleton height={88} />
      <CapiroSkeleton height={180} />
      <CapiroSkeleton height={140} />
    </div>
  );
}

/** Kit error state carrying the canonical page's exact words; no retry, as canonical. */
export function ProfileErrorState({ title, description }: { title: string; description: string }) {
  return <CapiroErrorState title={title} description={description} />;
}

/* ── Hero ────────────────────────────────────────────────────────────────── */

/**
 * Profile hero: identity mark beside the display name and caller-provided
 * pills/meta. The mark is decorative — the adjacent h1 carries the name.
 */
export function ProfileHero({
  name,
  photoUrl = null,
  kind = 'person',
  children,
}: {
  name: string;
  photoUrl?: string | null;
  kind?: IdentityKind;
  children?: ReactNode;
}) {
  return (
    <header className="capiro-dirpage__hero">
      <IdentityMark kind={kind} size="lg" name={name} imageUrl={photoUrl} aria-hidden="true" />
      <div className="capiro-dirpage__hero-main">
        <h1 className="capiro-dirpage__title">{name}</h1>
        {children}
      </div>
    </header>
  );
}

/* ── Cards ───────────────────────────────────────────────────────────────── */

/** Section card on the shared dirprofile chrome (title cap + bordered surface). */
export function ProfileCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="capiro-dirprofile-card capiro-dirpage__card">
      <p className="capiro-dirprofile-card__title">{title}</p>
      {children}
    </section>
  );
}

/** A label/value pair for a descriptions grid; dropped entirely when the value is blank. */
export type ProfileField = { label: string; value: string | null | undefined };

/**
 * vNext DescriptionsCard: renders only the fields that actually have a value
 * and disappears entirely when every field is blank — per the "don't show
 * empty fields" directory rule. No "Not provided by source" placeholders.
 */
export function ProfileDescriptions({ title, fields }: { title: string; fields: ProfileField[] }) {
  const present = fields.filter((f) => hasText(f.value));
  if (present.length === 0) return null;
  return (
    <ProfileCard title={title}>
      <dl className="capiro-dirpage__desc">
        {present.map((f) => (
          <div key={f.label} className="capiro-dirpage__desc-item">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </ProfileCard>
  );
}

/**
 * vNext ListCard: a card wrapping a list, omitted entirely when the list is
 * empty so sections with no data vanish rather than showing a placeholder.
 * Count is appended to the title.
 */
export function ProfileList<T>({
  title,
  items,
  render,
  showCount = true,
  layout = 'stack',
}: {
  title: string;
  items: T[] | null | undefined;
  render: (item: T, index: number) => ReactNode;
  showCount?: boolean;
  /** 'row' lays items out horizontally (the photos gallery); default stacks. */
  layout?: 'stack' | 'row';
}) {
  if (!items || items.length === 0) return null;
  return (
    <ProfileCard title={showCount ? `${title} (${items.length})` : title}>
      <div className={layout === 'row' ? 'capiro-dirpage__gallery' : 'capiro-dirpage__rows'}>
        {items.map((item, i) => render(item, i))}
      </div>
    </ProfileCard>
  );
}

/* ── Office address ──────────────────────────────────────────────────────── */

/** Render one physical office address, hiding any blank line within it. */
export function OfficeAddressBlock({ address: a }: { address: OfficeAddress }) {
  const cityLine = [a.city, a.state, [a.zip, a.zipExt].filter(Boolean).join('-')]
    .filter(Boolean)
    .join(', ');
  const streetLine = [a.address1, a.address2, cityLine].filter(hasText).join(', ');
  const heading = a.label || a.officeName;
  return (
    <div className="capiro-dirpage__address">
      {(hasText(heading) || a.isMain) && (
        <p className="capiro-dirpage__row-title">
          {hasText(heading) ? heading : null}{' '}
          {a.isMain ? <CapiroBadge tone="info">Main</CapiroBadge> : null}
        </p>
      )}
      {hasText(streetLine) ? <p className="capiro-dirprofile__line">{streetLine}</p> : null}
      {hasText(a.phone) || hasText(a.fax) ? (
        <p className="capiro-dirprofile__meta">
          {[hasText(a.phone) ? `Phone: ${a.phone}` : null, hasText(a.fax) ? `Fax: ${a.fax}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {hasText(a.publicNotes) ? <p className="capiro-dirprofile__meta">{a.publicNotes}</p> : null}
    </div>
  );
}

/* ── Privately funded travel ─────────────────────────────────────────────── */

function tripLine(t: DirectoryContactTripSummary) {
  const dateRange = [t.startDate, t.endDate].filter(Boolean).join(' – ');
  const destinations = t.destinations.map((d) => d.name).filter(hasText).join(', ');
  const sponsors = t.sponsors.map((s) => s.name).filter(hasText).join(', ');
  const cost = usd(t.totalCost);
  return (
    <div key={t.id} className="capiro-dirpage__trip">
      <p className="capiro-dirprofile__line">
        <CapiroBadge tone={t.role === 'traveler' ? 'info' : 'neutral'}>
          {t.role === 'traveler' ? 'Traveled' : 'Approved'}
        </CapiroBadge>
        {hasText(t.otherPartyName) ? (
          <strong className="capiro-dirpage__trip-party">
            {t.role === 'traveler' ? ` with ${t.otherPartyName}` : ` for ${t.otherPartyName}`}
          </strong>
        ) : null}
        {hasText(t.companionName) ? (
          <span className="capiro-dirprofile__meta"> · companion: {t.companionName}</span>
        ) : null}
      </p>
      <p className="capiro-dirprofile__meta">
        {[destinations || null, hasText(t.purpose) ? t.purpose : null, dateRange || null, cost]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {sponsors ? <p className="capiro-dirprofile__meta">Sponsor: {sponsors}</p> : null}
    </div>
  );
}

/**
 * WS-F, LegiStorm gaps/enrichment plan — privately funded travel disclosures
 * for a member OR staffer profile. Self-contained fetch (trips aren't part of
 * MemberDetail/StaffDetail) so it can drop into either profile view unchanged.
 * Renders nothing while loading, on error, or when the contact has no trips
 * on record — the same query key and "vanish when empty" behaviour as the
 * canonical ContactTripsSection.
 */
export function ContactTripsSectionVNext({ contactId }: { contactId: string }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['contact-trips', contactId],
    queryFn: () => getContactTrips(api, contactId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const trips = query.data?.trips;
  if (!trips || trips.length === 0) return null;

  return (
    <ProfileCard title={`Privately funded travel (${trips.length})`}>
      <div className="capiro-dirpage__rows">{trips.map(tripLine)}</div>
    </ProfileCard>
  );
}
