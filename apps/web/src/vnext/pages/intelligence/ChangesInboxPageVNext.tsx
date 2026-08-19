import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import type {
  IntelligenceChange,
  PortfolioAlertsResponse,
} from '../../../pages/intelligence/types.js';
import { PORTFOLIO_ALERT_CATEGORY_LABELS } from '../../../pages/intelligence/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { IntelAlert, IntelBellIcon, IntelPill, IntelSkeletonRows } from './intel-ui.js';

/**
 * Changes Inbox — vNext port of the canonical page
 * (pages/intelligence/ChangesInboxPage.tsx).
 *
 * Same two sources merged the same way: persisted change rows
 * (`/api/intelligence/changes?consumed=false`, query key
 * ['intel-changes-inbox', …]) plus compute-on-read portfolio alerts
 * (`/api/intelligence/portfolio-alerts`, key ['portfolio-alerts-inbox'])
 * rendered as synthetic `pa-` rows. Mark-read PATCH with optimistic flag +
 * rollback-and-tell semantics, the same failure-visible empty-state copy, and
 * the same PE-code deep links into Program Elements.
 */

const SEVERITY_TONE: Record<string, string> = {
  info: 'blue',
  notable: 'gold',
  critical: 'red',
};

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const PAGE_SIZE = 25;

export function ChangesInboxPageVNext() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useCapiroToast();

  const [selectedSource, setSelectedSource] = useState<string | undefined>();
  const [selectedSeverity, setSelectedSeverity] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<[string | null, string | null]>([null, null]);
  const [drawerRecord, setDrawerRecord] = useState<IntelligenceChange | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [resolveNotice, setResolveNotice] = useState(false);
  const [page, setPage] = useState(1);

  const changesQuery = useQuery<IntelligenceChange[]>({
    queryKey: ['intel-changes-inbox', selectedSource, selectedSeverity, dateRange],
    queryFn: async () =>
      (
        await api.get<IntelligenceChange[]>('/api/intelligence/changes', {
          params: {
            // Inbox semantics: only show changes the user hasn't cleared. A
            // mark-read PATCH persists consumed=true, so cleared rows stay gone
            // across reloads instead of resurfacing.
            consumed: false,
            ...(selectedSource ? { source: selectedSource } : {}),
            ...(dateRange[0] ? { since: dateRange[0] } : {}),
          },
        })
      ).data,
    staleTime: 2 * 60 * 1000,
  });

  // Cross-client alert roll-up — same taxonomy as the client Intelligence tab
  // Top Alerts and the dashboard Needs-Attention banner. Compute-on-read
  // alerts (NOT intelligence_change rows) merged in as synthetic rows, with
  // their categories exposed as source filters. No try/catch: `.isError` must
  // stay visible so a real outage never renders as "No changes found".
  const portfolioAlertsQuery = useQuery<PortfolioAlertsResponse>({
    queryKey: ['portfolio-alerts-inbox'],
    queryFn: async () =>
      (
        await api.get<PortfolioAlertsResponse>('/api/intelligence/portfolio-alerts', {
          params: { limit: 50 },
        })
      ).data,
    staleTime: 2 * 60 * 1000,
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.patch(`/api/intelligence/changes/${id}`, { consumed: true });
    },
    // Optimistically flag the row read so the UI responds instantly, but treat
    // the server PATCH as the source of truth: roll the optimistic flag back on
    // failure and tell the user, so "I cleared it but it came back" can never be
    // a silent lie. The persisted `consumed` column is what survives reloads.
    onMutate: (id: string) => {
      setReadIds((prev) => new Set([...prev, id]));
      return { id };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['intel-changes-inbox'] });
      void qc.invalidateQueries({ queryKey: ['intel-changes-unread'] });
    },
    onError: (_err, _id, context) => {
      if (context?.id) {
        setReadIds((prev) => {
          const next = new Set(prev);
          next.delete(context.id);
          return next;
        });
      }
      toast.error(
        "Couldn't mark as read — the change was reopened. Check your connection and try again.",
      );
    },
  });

  // Convert the cross-client portfolio alerts into inbox rows so the inbox
  // reflects the SAME alert categories as the dashboard + client tab.
  const portfolioAlertRows = useMemo<IntelligenceChange[]>(() => {
    const alerts = portfolioAlertsQuery.data?.alerts ?? [];
    return alerts.map((a) => ({
      id: `pa-${a.id}`,
      source: a.type,
      changeType: a.type,
      severity: a.severity === 'critical' || a.severity === 'notable' ? a.severity : 'info',
      title: a.title,
      description: [a.clientName, a.subtitle, a.countdownLabel].filter(Boolean).join(' · '),
      relatedClientIds: a.clientId ? [a.clientId] : [],
      relatedIssues: [],
      data: { portfolioAlert: true, href: a.href ?? null, clientName: a.clientName },
      detectedAt: a.when || new Date().toISOString(),
      consumed: false,
    }));
  }, [portfolioAlertsQuery.data]);

  const allChanges = useMemo(
    () => [...(changesQuery.data ?? []), ...portfolioAlertRows],
    [changesQuery.data, portfolioAlertRows],
  );

  const filteredChanges = useMemo(() => {
    let data = allChanges;
    if (selectedSource) data = data.filter((c) => c.source === selectedSource);
    if (selectedSeverity) data = data.filter((c) => c.severity === selectedSeverity);
    if (dateRange[1]) {
      const end = new Date(dateRange[1]).getTime();
      data = data.filter((c) => new Date(c.detectedAt).getTime() <= end);
    }
    return [...data].sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
    );
  }, [allChanges, selectedSource, selectedSeverity, dateRange]);

  const distinctSources = useMemo(() => {
    // Always offer the portfolio-alert categories as filter options (even when
    // none are currently present) so the inbox advertises the full taxonomy,
    // then union with whatever sources the live change/alert rows carry.
    const curated = Object.keys(PORTFOLIO_ALERT_CATEGORY_LABELS);
    return [...new Set([...curated, ...allChanges.map((c) => c.source)])].sort();
  }, [allChanges]);

  const unreadCount = filteredChanges.filter(
    (c) => !readIds.has(c.id) && !(c as IntelligenceChange & { consumed?: boolean }).consumed,
  ).length;

  const pageCount = Math.max(1, Math.ceil(filteredChanges.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = filteredChanges.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function isRead(record: IntelligenceChange): boolean {
    return (
      readIds.has(record.id) ||
      Boolean((record as IntelligenceChange & { consumed?: boolean }).consumed)
    );
  }

  function handleRowClick(record: IntelligenceChange) {
    // Synthetic portfolio-alert rows (compute-on-read) aren't persisted change
    // rows: don't PATCH mark-read (the id has no DB row). Navigate to the
    // alert's deep link when present, otherwise just open the drawer.
    const isPortfolioAlert = record.id.startsWith('pa-');
    if (isPortfolioAlert) {
      const href = (record.data as { href?: string | null } | undefined)?.href;
      if (href) {
        navigate(href);
        return;
      }
      setDrawerRecord(record);
      return;
    }
    setDrawerRecord(record);
    if (!readIds.has(record.id)) {
      markReadMutation.mutate(record.id);
    }
  }

  const relatedPeCodes = drawerRecord
    ? ((drawerRecord as IntelligenceChange & { relatedPeCodes?: string[] }).relatedPeCodes ?? [])
    : [];

  return (
    <div className="intel intel-changes-inbox">
      <header className="intel-head">
        <div className="intel-head__title-row">
          <span className="intel-head__icon">
            <IntelBellIcon size={20} />
          </span>
          <h2 className="intel-head__title">Changes Inbox</h2>
          {unreadCount > 0 ? (
            <CapiroBadge tone="danger" aria-label={`${unreadCount} unread`}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </CapiroBadge>
          ) : null}
        </div>
        <CapiroButton size="compact" onClick={() => setResolveNotice(true)}>
          Resolve All Clients
        </CapiroButton>
      </header>

      {resolveNotice ? (
        <IntelAlert
          tone="info"
          message="Use the Intelligence Mappings page to resolve entity mappings."
          onClose={() => setResolveNotice(false)}
        />
      ) : null}

      {/* Filter bar */}
      <div className="intel-filter-panel" aria-label="Changes inbox filters">
        <label className="capiro-field" style={{ minWidth: 200 }}>
          <span className="capiro-field__label">Source</span>
          <select
            className="capiro-select"
            aria-label="Source"
            value={selectedSource ?? ''}
            onChange={(event) => {
              setSelectedSource(event.target.value || undefined);
              setPage(1);
            }}
          >
            <option value="">All sources</option>
            {distinctSources.map((s) => (
              <option key={s} value={s}>
                {PORTFOLIO_ALERT_CATEGORY_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <label className="capiro-field" style={{ width: 140 }}>
          <span className="capiro-field__label">Severity</span>
          <select
            className="capiro-select"
            aria-label="Severity"
            value={selectedSeverity ?? ''}
            onChange={(event) => {
              setSelectedSeverity(event.target.value || undefined);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="info">Info</option>
            <option value="notable">Notable</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="capiro-field">
          <span className="capiro-field__label">Detected from</span>
          <input
            className="capiro-input"
            type="date"
            aria-label="Detected from"
            value={dateRange[0] ?? ''}
            onChange={(event) => {
              setDateRange([event.target.value || null, dateRange[1]]);
              setPage(1);
            }}
          />
        </label>
        <label className="capiro-field">
          <span className="capiro-field__label">Detected to</span>
          <input
            className="capiro-input"
            type="date"
            aria-label="Detected to"
            value={dateRange[1] ?? ''}
            onChange={(event) => {
              setDateRange([dateRange[0], event.target.value || null]);
              setPage(1);
            }}
          />
        </label>
      </div>

      {changesQuery.isLoading ? (
        <IntelSkeletonRows rows={8} />
      ) : filteredChanges.length === 0 ? (
        <CapiroEmptyState
          title={
            changesQuery.isError || portfolioAlertsQuery.isError
              ? "Couldn't load some sources — this list may be incomplete. Try refreshing."
              : 'No changes found'
          }
        />
      ) : (
        <CapiroTableWrap>
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell style={{ width: 100 }}>Severity</CapiroTableHeaderCell>
                <CapiroTableHeaderCell style={{ width: 140 }}>Source</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Title</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Description</CapiroTableHeaderCell>
                <CapiroTableHeaderCell style={{ width: 130 }}>Detected</CapiroTableHeaderCell>
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {pageRows.map((record) => (
                <tr
                  key={record.id}
                  className={`intel-row${isRead(record) ? ' intel-row--read' : ''}`}
                  tabIndex={0}
                  aria-label={`Open change: ${record.title}`}
                  onClick={() => handleRowClick(record)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleRowClick(record);
                    }
                  }}
                >
                  <CapiroTableCell>
                    <IntelPill tone={SEVERITY_TONE[record.severity] ?? 'default'} className="intel-capitalize">
                      {record.severity}
                    </IntelPill>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <IntelPill>{PORTFOLIO_ALERT_CATEGORY_LABELS[record.source] ?? record.source}</IntelPill>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <span className={isRead(record) ? 'intel-title--read' : 'intel-title--unread'}>
                      {record.title}
                    </span>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <span className="intel-desc-cell" title={record.description}>
                      {record.description.length > 120
                        ? record.description.slice(0, 120) + '…'
                        : record.description}
                    </span>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <span className="intel-micro" title={new Date(record.detectedAt).toLocaleString()}>
                      {relativeTime(record.detectedAt)}
                    </span>
                  </CapiroTableCell>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
          {filteredChanges.length > PAGE_SIZE ? (
            <div className="intel-pagination">
              <span>
                Page {currentPage} of {pageCount}
              </span>
              <CapiroButton size="compact" disabled={currentPage <= 1} onClick={() => setPage((v) => v - 1)}>
                Previous
              </CapiroButton>
              <CapiroButton
                size="compact"
                disabled={currentPage >= pageCount}
                onClick={() => setPage((v) => v + 1)}
              >
                Next
              </CapiroButton>
            </div>
          ) : null}
        </CapiroTableWrap>
      )}

      <CapiroDrawer
        open={Boolean(drawerRecord)}
        title={drawerRecord?.title ?? 'Change Detail'}
        onClose={() => setDrawerRecord(null)}
      >
        {drawerRecord ? (
          <div className="intel intel-drawer-body" style={{ padding: 0, background: 'none' }}>
            <div className="intel-drawer-section">
              <span>Severity</span>
              <div className="intel-drawer-pills">
                <IntelPill tone={SEVERITY_TONE[drawerRecord.severity] ?? 'default'} className="intel-capitalize">
                  {drawerRecord.severity}
                </IntelPill>
              </div>
            </div>
            <div className="intel-drawer-section">
              <span>Source</span>
              <div className="intel-drawer-pills">
                <IntelPill>{drawerRecord.source}</IntelPill>
              </div>
            </div>
            <div className="intel-drawer-section">
              <span>Detected</span>
              <span style={{ fontSize: 13 }}>{new Date(drawerRecord.detectedAt).toLocaleString()}</span>
            </div>
            {drawerRecord.relatedIssues.length > 0 ? (
              <div className="intel-drawer-section">
                <span>Related Issues</span>
                <div className="intel-drawer-pills">
                  {drawerRecord.relatedIssues.map((iss) => (
                    <IntelPill key={iss}>{iss}</IntelPill>
                  ))}
                </div>
              </div>
            ) : null}
            {relatedPeCodes.length > 0 ? (
              <div className="intel-drawer-section">
                <span>Program Elements</span>
                <div className="intel-drawer-pills">
                  {relatedPeCodes.map((peCode) => (
                    <IntelPill
                      key={peCode}
                      tone="blue"
                      onClick={() => navigate(`/program-elements/${encodeURIComponent(peCode)}`)}
                    >
                      PE {peCode}
                    </IntelPill>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="intel-drawer-section">
              <span>Description</span>
              <p className="intel-drawer-description">{drawerRecord.description}</p>
            </div>
            {Object.keys(drawerRecord.data).length > 0 ? (
              <div className="intel-drawer-section">
                <span>Raw Data</span>
                <pre className="intel-raw-data">{JSON.stringify(drawerRecord.data, null, 2)}</pre>
              </div>
            ) : null}
          </div>
        ) : (
          <span />
        )}
      </CapiroDrawer>
    </div>
  );
}
