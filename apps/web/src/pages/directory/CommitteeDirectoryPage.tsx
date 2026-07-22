import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Card, Input, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getCommitteeContacts } from './directory-api.js';
import { CommitteeContactList } from './CommitteeContactList.js';

const { Title, Text, Paragraph } = Typography;

type PersonTypeFilter = 'all' | 'member' | 'staff';

export default function CommitteeDirectoryPage() {
  const { committeeId } = useParams<{ committeeId: string }>();
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  // Filters persist in the URL so a filtered committee view is shareable.
  const personType = (searchParams.get('personType') as PersonTypeFilter) || 'all';
  const current = searchParams.get('current') === 'true';
  const q = searchParams.get('q') ?? '';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const query = useQuery({
    queryKey: ['directory-committee-contacts', committeeId, personType, current, q],
    queryFn: () =>
      getCommitteeContacts(api, committeeId!, {
        personType: personType === 'all' ? undefined : personType,
        current: current ? 'true' : undefined,
        q: q || undefined,
        pageSize: 500,
      }),
    enabled: Boolean(committeeId),
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const committee = query.data?.committee ?? null;

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <Paragraph>
        <Link to="/directory">← Back to directory</Link>
      </Paragraph>

      {query.isLoading ? (
        <Spin />
      ) : query.isError ? (
        <Alert type="error" showIcon message="Committee unavailable" description="This committee could not be found in the current directory snapshot." />
      ) : (
        <>
          <Title level={3} style={{ marginBottom: 4 }}>
            {committee?.name ?? committeeId}
          </Title>
          <Space wrap size={[6, 6]} style={{ marginBottom: 8 }}>
            {committee?.chamber ? <Tag color="blue">{committee.chamber}</Tag> : null}
            {committee?.kind ? <Tag>{committee.kind}</Tag> : null}
            {committee?.committeeCode ? <Tag>{committee.committeeCode}</Tag> : null}
            {typeof committee?.memberCount === 'number' ? (
              <Text type="secondary">{committee.memberCount} members</Text>
            ) : null}
            {typeof committee?.currentStaffCount === 'number' ? (
              <Text type="secondary">· {committee.currentStaffCount} current staff</Text>
            ) : null}
          </Space>

          {committee?.officeLocation?.trim() || committee?.phone?.trim() ? (
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {[committee?.officeLocation?.trim(), committee?.phone?.trim() ? `Phone: ${committee.phone.trim()}` : null]
                .filter(Boolean)
                .join(' · ')}
            </Paragraph>
          ) : null}

          {committee?.parentCommittee ? (
            <Paragraph>
              Parent committee:{' '}
              <Link to={`/directory/committees/${encodeURIComponent(committee.parentCommittee.id)}`}>
                {committee.parentCommittee.name}
              </Link>
            </Paragraph>
          ) : null}

          {committee?.subcommittees && committee.subcommittees.length > 0 ? (
            <Card size="small" title="Subcommittees" style={{ marginBottom: 16 }}>
              {committee.subcommittees.map((s) => (
                <div key={s.id}>
                  <Link to={`/directory/committees/${encodeURIComponent(s.id)}`}>{s.name}</Link>
                </div>
              ))}
            </Card>
          ) : null}

          <Space style={{ marginBottom: 12 }} wrap>
            <Segmented
              value={personType}
              onChange={(value) => setParam('personType', value === 'all' ? null : String(value))}
              options={[
                { label: 'Contacts', value: 'all' },
                { label: 'Members', value: 'member' },
                { label: 'Staff', value: 'staff' },
              ]}
            />
            <Segmented
              value={current ? 'current' : 'any'}
              onChange={(value) => setParam('current', value === 'current' ? 'true' : null)}
              options={[
                { label: 'All', value: 'any' },
                { label: 'Current only', value: 'current' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="Filter by name or role"
              defaultValue={q}
              onSearch={(value) => setParam('q', value || null)}
              style={{ width: 260 }}
            />
          </Space>

          <CommitteeContactList contacts={query.data?.contacts ?? []} />
        </>
      )}
    </div>
  );
}
