import { useQuery } from '@tanstack/react-query';
import { Card, Tag, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getContactTrips, type DirectoryContactTripSummary } from './directory-api.js';
import { hasText } from './directory-profile-helpers.js';

const { Text } = Typography;

function usd(v: number | null): string | null {
  return v == null ? null : `$${Math.round(v).toLocaleString('en-US')}`;
}

function tripLine(t: DirectoryContactTripSummary) {
  const dateRange = [t.startDate, t.endDate].filter(Boolean).join(' – ');
  const destinations = t.destinations.map((d) => d.name).filter(hasText).join(', ');
  const sponsors = t.sponsors.map((s) => s.name).filter(hasText).join(', ');
  const cost = usd(t.totalCost);
  return (
    <div key={t.id} style={{ marginBottom: 10 }}>
      <div>
        <Tag color={t.role === 'traveler' ? 'blue' : 'default'}>
          {t.role === 'traveler' ? 'Traveled' : 'Approved'}
        </Tag>
        {hasText(t.otherPartyName) ? (
          <Text strong>
            {t.role === 'traveler' ? ` with ${t.otherPartyName}` : ` for ${t.otherPartyName}`}
          </Text>
        ) : null}
        {hasText(t.companionName) ? <Text type="secondary"> · companion: {t.companionName}</Text> : null}
      </div>
      <Text type="secondary">
        {[destinations || null, hasText(t.purpose) ? t.purpose : null, dateRange || null, cost]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {sponsors ? (
        <div>
          <Text type="secondary">Sponsor: {sponsors}</Text>
        </div>
      ) : null}
    </div>
  );
}

/**
 * WS-F, LegiStorm gaps/enrichment plan — privately funded travel disclosures
 * for a member OR staffer profile. Self-contained fetch (trips aren't part
 * of MemberDetail/StaffDetail) so it can drop into either profile view
 * unchanged. Renders nothing while loading, on error, or when the contact
 * has no trips on record — matches the rest of this page's "vanish when
 * empty" convention rather than cluttering every profile with a placeholder.
 */
export function ContactTripsSection({ contactId }: { contactId: string }) {
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
    <Card size="small" title={`Privately funded travel (${trips.length})`} style={{ marginBottom: 16 }}>
      {trips.map(tripLine)}
    </Card>
  );
}
