import { Alert, Button, Empty, Spin, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useSavedHearingRecaps } from '../../../lib/hearing-watch-api.js';

const { Text } = Typography;

export function SavedHearingRecapsPanel({ clientId }: { clientId: string }) {
  const navigate = useNavigate();
  const query = useSavedHearingRecaps(clientId);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isLoading) {
    return (
      <div style={{ textAlign: 'center', padding: 36 }}>
        <Spin />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Couldn’t load saved hearing recaps"
        description="The Documents service is temporarily unavailable."
        action={
          <Button size="small" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!items.length) {
    return (
      <Empty description="No hearing recaps have been saved for this client yet. End a hearing session and choose Save recap." />
    );
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="hint">
        Saved recaps are client Documents and are indexed into Meri knowledge. Source-linked recaps
        reopen the hearing session.
      </div>
      {items.map((item) => (
        <div className="hsession" key={item.id}>
          <div className="st" style={{ minWidth: 0 }}>
            <div className="t1">{item.sessionTitle ?? item.fileName}</div>
            <div className="t2">
              <span>{new Date(item.createdAt).toLocaleDateString()}</span>
              <span>·</span>
              <span>{item.fileName}</span>
            </div>
          </div>
          {item.indexedAt ? <Tag color="green">Indexed for Meri</Tag> : <Tag>Indexing</Tag>}
          {item.sessionId ? (
            <Button
              size="small"
              onClick={() =>
                navigate(`/intelligence/hearing-watch/${encodeURIComponent(item.sessionId!)}`)
              }
            >
              Open hearing
            </Button>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Legacy recap — source session unavailable
            </Text>
          )}
        </div>
      ))}
      {query.hasNextPage ? (
        <Button
          size="small"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more saved recaps
        </Button>
      ) : null}
    </div>
  );
}
