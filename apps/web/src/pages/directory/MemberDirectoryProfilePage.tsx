import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Alert, Spin, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getMemberDetail } from './directory-api.js';
import { MemberProfileView } from './MemberProfileView.js';

const { Paragraph } = Typography;

export default function MemberDirectoryProfilePage() {
  const { memberId } = useParams<{ memberId: string }>();
  const api = useApi();
  const query = useQuery({
    queryKey: ['directory-member-detail', memberId],
    queryFn: () => getMemberDetail(api, memberId!),
    enabled: Boolean(memberId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <Paragraph>
        <Link to="/directory">← Back to directory</Link>
      </Paragraph>
      {query.isLoading ? (
        <Spin />
      ) : query.isError || !query.data ? (
        <Alert
          type="error"
          showIcon
          message="Member profile unavailable"
          description="This member could not be found in the current directory snapshot."
        />
      ) : (
        <MemberProfileView member={query.data} />
      )}
    </div>
  );
}
