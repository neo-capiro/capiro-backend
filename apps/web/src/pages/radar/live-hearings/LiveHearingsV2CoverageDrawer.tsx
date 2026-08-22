import { useState } from 'react';
import { Alert, Button, Drawer, Empty, Spin } from 'antd';
import { DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import { liveHearingApiError, useLiveHearingsCoverage } from './live-hearings-api.js';

function titleCase(value?: string): string {
  return (value ?? 'Unknown')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Global operator transparency for every V2 Live Hearings view. */
export function LiveHearingsV2CoverageDrawer() {
  const [open, setOpen] = useState(false);
  const coverage = useLiveHearingsCoverage();
  const summary = coverage.data?.summary;
  const unhealthy = (summary?.degraded ?? 0) + (summary?.failing ?? 0) + (summary?.unknown ?? 0);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Button icon={<DatabaseOutlined />} onClick={() => setOpen(true)}>
          Source coverage{summary ? ` · ${summary.healthy}/${summary.total} healthy` : ''}
        </Button>
      </div>
      <Drawer
        title="Live Hearings source coverage"
        placement="right"
        width={520}
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={coverage.isFetching}
            onClick={() => void coverage.refetch()}
          >
            Refresh
          </Button>
        }
      >
        {coverage.isLoading ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', minHeight: 180 }}>
            <Spin /> Loading source health…
          </div>
        ) : null}
        {coverage.isError ? (
          <Alert
            type="error"
            showIcon
            message="Coverage data could not be loaded"
            description={liveHearingApiError(coverage.error)}
          />
        ) : null}
        {summary ? (
          <Alert
            type={unhealthy ? 'warning' : 'success'}
            showIcon
            message={`${summary.healthy} of ${summary.total} registered sources are healthy`}
            description={`${summary.degraded} degraded · ${summary.failing} failing · ${summary.unknown} unknown. A zero-event source is never treated as healthy merely because it returned no hearings.`}
            style={{ marginBottom: 16 }}
          />
        ) : null}
        {!coverage.isLoading && !coverage.isError && !(coverage.data?.sources.length ?? 0) ? (
          <Empty description="No registered source-health rows are available." />
        ) : null}
        <div style={{ display: 'grid', gap: 10 }}>
          {coverage.data?.sources.map((source) => (
            <article
              key={source.id}
              style={{ border: '1px solid #e4e7eb', borderRadius: 10, padding: 12, display: 'grid', gap: 5 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <strong>{source.committeeName ?? source.committeeSystemCode ?? titleCase(source.chamber)}</strong>
                <span>{titleCase(source.sourceHealth)}</span>
              </div>
              <small>{titleCase(source.sourceType)} · {source.adapterKey}</small>
              <small>Last success: {source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString() : 'Not recorded'}</small>
              {source.recentCapturePolicy ? <small>Observed capture policy: {titleCase(source.recentCapturePolicy)}</small> : null}
              {source.lastError ? <small style={{ color: '#9b2c2c' }}>{source.lastError}</small> : null}
            </article>
          ))}
        </div>
      </Drawer>
    </>
  );
}

export default LiveHearingsV2CoverageDrawer;
