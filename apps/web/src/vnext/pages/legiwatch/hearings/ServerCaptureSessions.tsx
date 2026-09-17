import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LwButton, LwPill, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import {
  useServerCaptureSessions,
  type ServerCaptureSession,
} from '../lib/wave1-api.js';
import { formatHearingDay, formatHearingTime, parseHearingMoment } from '../lib/hearing-datetime.js';

const PAGE_SIZE = 50;

/**
 * Durable all-lifecycle SERVER capture attendance for exactly this tenant+user.
 * Shown inside My Sessions as the "Server captures" group — NOT the old
 * week-derived "Scheduled recordings" card. Independent of the selected
 * calendar week and of any client/jurisdiction filter: a scheduled row appears
 * immediately and stays visible through started/processing/completed/failed.
 * Rows open the canonical hearing detail route (mouse and keyboard).
 */
export function ServerCaptureSessions() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const query = useServerCaptureSessions(page, PAGE_SIZE);
  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamp: an identity switch or a shrunk total must not strand the user on a
  // page that no longer exists.
  useEffect(() => {
    if (query.data && page > totalPages) setPage(totalPages);
  }, [query.data, page, totalPages]);

  const open = (row: ServerCaptureSession) => {
    navigate(`/legiwatch/hearings/${encodeURIComponent(row.id)}`);
  };

  return (
    <div className="lw-server-sessions" aria-label="Server captures list">
      <div className="lw-history__label">
        Server captures{query.data ? ` · ${total}` : ''}
      </div>
      {query.isLoading ? (
        <div role="status" aria-label="Loading server captures" style={{ padding: '8px 0' }}>
          <LwSkeleton height={28} />
          <LwSkeleton height={28} delay={2} />
        </div>
      ) : query.isError ? (
        <LwStateUnavailable
          source="Server captures"
          reason="Your server capture attendance could not be refreshed. This does not mean no capture is scheduled."
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <div className="lw-recs__empty">
          No server captures yet. Open a hearing and request automatic attendance; it keeps
          recording on the server even when you leave.
        </div>
      ) : (
        <div className="lw-history__rows">
          {rows.map((row) => {
            const m = parseHearingMoment({
              date: row.date ?? '',
              startsAt: row.startsAt,
              time: row.time,
              timeZone: row.timeZone,
            });
            const status = row.capture?.status?.toUpperCase() ?? null;
            const canceled = row.eventStatus === 'canceled';
            const postponed = row.eventStatus === 'postponed';
            const notPublic = row.visibility !== 'public';
            // Proceeding status is DISTINCT from capture status: a canceled /
            // postponed / no-longer-public proceeding never shows a misleading
            // SCHEDULED-pending capture badge.
            const pill = canceled
              ? { tone: 'gray' as const, label: 'CANCELED' }
              : notPublic
                ? { tone: 'gray' as const, label: 'CLOSED' }
                : postponed
                  ? { tone: 'warning' as const, label: 'POSTPONED' }
                  : row.capturePending
                    ? { tone: 'brand' as const, label: 'SCHEDULED' }
                    : status === 'COMPLETE' || status === 'COMPLETE_WITH_GAPS'
                      ? { tone: 'success' as const, label: 'COMPLETE' }
                      : status === 'FAILED' || status === 'BLOCKED'
                        ? { tone: 'warning' as const, label: status }
                        : status
                          ? { tone: 'brand' as const, label: status }
                          : { tone: 'gray' as const, label: 'SCHEDULED' };
            const when = row.date ? `${formatHearingDay(m)} · ${formatHearingTime(m)}` : '';
            return (
              <div
                key={row.id}
                className="lw-hrow"
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
                onClick={() => open(row)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    open(row);
                  }
                }}
                aria-label={`Open ${row.title}`}
              >
                <div>
                  <div className="lw-hrow__title">{row.title}</div>
                  <div className="lw-hrow__sub">
                    {when}
                    {row.committeeName ? ` · ${row.committeeName}` : ''}
                    {row.eventStatus === 'canceled'
                      ? ' · Proceeding canceled'
                      : row.eventStatus === 'postponed'
                        ? ' · Postponed'
                        : ''}
                    {row.visibility !== 'public' ? ' · No longer public' : ''}
                  </div>
                </div>
                <span className="lw-hrow__pill">
                  <LwPill tone={pill.tone}>{pill.label}</LwPill>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {totalPages > 1 ? (
        <div className="lw-controls" style={{ marginTop: 8 }}>
          <LwButton disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Newer
          </LwButton>
          <span className="lw-card__meta">
            Page {page} of {totalPages}
          </span>
          <LwButton
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Older
          </LwButton>
        </div>
      ) : null}
    </div>
  );
}
