import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type { IssueLeaderboard, LeaderboardRegistrant } from '../../../pages/intelligence/types.js';
import { formatMoney, formatNum } from '../../../pages/intelligence/utils-shared.js';
import { CapiroIconButton } from '../../components/actions/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  IntelAlert,
  IntelArrowLeftIcon,
  IntelPill,
  IntelSkeletonRows,
  IntelStat,
  IntelTrophyIcon,
} from './intel-ui.js';

/**
 * Issue Leaderboard — vNext port of the canonical page
 * (pages/intelligence/IssueLeaderboardPage.tsx).
 *
 * Same endpoint (`/api/intelligence/issues/:code/leaderboard`), same query key
 * (`['issue-leaderboard', code]`), same stats, columns, copy, and states. The
 * `:code` param arrives as a prop parsed from location.pathname by the module
 * router (VNextRouter mounts above the canonical param routes — Phase 3
 * briefing lesson 2).
 */

type SortKey = 'filingCount' | 'totalIncome';

const PAGE_SIZE = 20;

export function IssueLeaderboardPageVNext({ code }: { code: string }) {
  const navigate = useNavigate();
  const api = useApi();
  const [sortKey, setSortKey] = useState<SortKey>('filingCount');
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);

  const query = useQuery<IssueLeaderboard>({
    queryKey: ['issue-leaderboard', code],
    queryFn: async () =>
      (await api.get<IssueLeaderboard>(`/api/intelligence/issues/${code}/leaderboard`)).data,
    enabled: !!code,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data;

  const sorted = useMemo(() => {
    const rows = [...(data?.registrants ?? [])];
    rows.sort((a, b) => (sortDesc ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));
    return rows;
  }, [data?.registrants, sortKey, sortDesc]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((value) => !value);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
    setPage(1);
  };

  const sortMarker = (key: SortKey) => (sortKey === key ? (sortDesc ? ' ↓' : ' ↑') : '');

  const newEntrantCount = data?.registrants.filter((r) => r.isNewEntrant).length ?? 0;
  const sharedLobbyistCount =
    data?.registrants.filter((r) => r.sharedLobbyists.length > 0).length ?? 0;

  return (
    <div className="intel intel-issue-leaderboard">
      <header className="intel-head">
        <div className="intel-head__title-row">
          <CapiroIconButton
            label="Back"
            icon={<IntelArrowLeftIcon size={15} />}
            onClick={() => navigate(-1)}
          />
          <span className="intel-head__icon">
            <IntelTrophyIcon size={20} />
          </span>
          <h2 className="intel-head__title">Issue Leaderboard: {code}</h2>
          {data ? <IntelPill>{data.issueName}</IntelPill> : null}
        </div>
      </header>

      {query.isLoading ? <IntelSkeletonRows rows={12} /> : null}

      {query.isError ? (
        <IntelAlert
          tone="error"
          message="Failed to load leaderboard"
          description={(query.error as Error)?.message}
        />
      ) : null}

      {data ? (
        <>
          <div className="intel-stats">
            <IntelStat label="Total Filings (2y)" value={formatNum(data.totalFilings)} />
            <IntelStat label="Registrants" value={data.registrants.length} />
            <IntelStat
              label="New Entrants (90d)"
              value={newEntrantCount}
              tone={newEntrantCount > 0 ? 'danger' : undefined}
            />
            <IntelStat
              label="Shared Lobbyist Overlap"
              value={sharedLobbyistCount}
              tone={sharedLobbyistCount > 0 ? 'warning' : undefined}
            />
          </div>

          {data.registrants.length === 0 ? (
            <CapiroEmptyState title="No registrants found" />
          ) : (
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell style={{ width: 50 }}>#</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Registrant</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell style={{ width: 110 }} aria-sort={sortKey === 'filingCount' ? (sortDesc ? 'descending' : 'ascending') : undefined}>
                      <button type="button" className="intel-th-sort" onClick={() => toggleSort('filingCount')}>
                        Filings (2y){sortMarker('filingCount')}
                      </button>
                    </CapiroTableHeaderCell>
                    <CapiroTableHeaderCell style={{ width: 140 }} aria-sort={sortKey === 'totalIncome' ? (sortDesc ? 'descending' : 'ascending') : undefined}>
                      <button type="button" className="intel-th-sort" onClick={() => toggleSort('totalIncome')}>
                        Total Income{sortMarker('totalIncome')}
                      </button>
                    </CapiroTableHeaderCell>
                    <CapiroTableHeaderCell style={{ width: 120 }}>First Filing</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell style={{ width: 160 }}>Shared Lobbyists</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {pageRows.map((record: LeaderboardRegistrant, idx: number) => (
                    <tr key={record.name}>
                      <CapiroTableCell>
                        <span className="intel-micro">{(currentPage - 1) * PAGE_SIZE + idx + 1}</span>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13 }}>{record.name}</span>
                          {record.isNewEntrant ? <IntelPill tone="red">NEW</IntelPill> : null}
                        </span>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <strong>{formatNum(record.filingCount)}</strong>
                      </CapiroTableCell>
                      <CapiroTableCell>{formatMoney(record.totalIncome)}</CapiroTableCell>
                      <CapiroTableCell>
                        {record.firstFilingDate
                          ? new Date(record.firstFilingDate).toLocaleDateString()
                          : '-'}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {record.sharedLobbyists.length > 0 ? (
                          <IntelPill tone="orange" title={record.sharedLobbyists.join(', ')}>
                            {record.sharedLobbyists.length} shared lobbyist
                            {record.sharedLobbyists.length > 1 ? 's' : ''}
                          </IntelPill>
                        ) : null}
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
              {sorted.length > PAGE_SIZE ? (
                <div className="intel-pagination">
                  <span>
                    Page {currentPage} of {pageCount}
                  </span>
                  <CapiroButton
                    size="compact"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous
                  </CapiroButton>
                  <CapiroButton
                    size="compact"
                    disabled={currentPage >= pageCount}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </CapiroButton>
                </div>
              ) : null}
            </CapiroTableWrap>
          )}
        </>
      ) : null}
    </div>
  );
}
