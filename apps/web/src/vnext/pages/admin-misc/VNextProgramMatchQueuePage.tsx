/**
 * vNext re-skin of pages/program-element/ProgramMatchQueuePage.tsx — the Step
 * 2.1 PE→Program match review queue (capiro_admin only). Identical endpoints
 * and query keys (programs-api.js reused verbatim), Why-shown evidence line,
 * confidence band, per-row notes, and the accept / quarantine / reject
 * decisions (confirmed, audit-logged server-side; resolving invalidates this
 * queue + the PE Programs panel). The client-side capiro_admin gate is an
 * affordance; the server's RolesGuard is the boundary.
 *
 * `standalone` wraps the queue in the module page frame (used by the
 * /admin/program-element/match-queue route); the Analyst Console mounts it
 * bare as a tab, exactly like canonical.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import {
  getProgramMatchQueue,
  resolveProgramMatch,
} from '../../../pages/program-element/programs-api.js';
import type {
  ProgramConfidenceBand,
  ProgramEvidenceItem,
  ProgramMatchDecision,
  ProgramMatchQueueRow,
} from '../../../pages/program-element/programs-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTooltip } from '../../components/menus/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import {
  SvCallout,
  SvCard,
  SvPagination,
  SvSortHeader,
  useSvConfirm,
  useSvPagination,
  useSvSort,
} from '../settings/settings-ui.js';

type StatusFilter = 'candidate' | 'quarantined' | 'all';

// Canonical BAND_COLOR (green/gold/orange/default) mapped onto the badge tone
// vocabulary — medium and low both land on 'warning' in the 5-tone system.
const BAND_TONE: Record<ProgramConfidenceBand, CapiroBadgeTone> = {
  high: 'success',
  medium: 'warning',
  low: 'warning',
  weak: 'neutral',
};

function bandBadge(band: ProgramConfidenceBand) {
  return <CapiroBadge tone={BAND_TONE[band] ?? 'neutral'}>{band}</CapiroBadge>;
}

function statusBadge(status: string) {
  const tone: CapiroBadgeTone =
    status === 'candidate' ? 'warning' : status === 'quarantined' ? 'danger' : 'neutral';
  return <CapiroBadge tone={tone}>{status}</CapiroBadge>;
}

function evidenceHref(item: ProgramEvidenceItem): string | null {
  if (!item.sourceUrl) return null;
  return item.pageNumber ? `${item.sourceUrl}#page=${item.pageNumber}` : item.sourceUrl;
}

function EvidenceLinks({ evidence }: { evidence: ProgramEvidenceItem[] }) {
  const linked = (Array.isArray(evidence) ? evidence : []).filter((e) => e.sourceUrl);
  if (linked.length === 0) return <span className="stv-muted">—</span>;
  return (
    <span className="stv-row" style={{ gap: 4 }}>
      {linked.map((e, i) => {
        const href = evidenceHref(e);
        const label = `${e.kind ?? 'source'}${e.pageNumber ? ` p.${e.pageNumber}` : ''}`;
        return href ? (
          <a key={`${href}-${i}`} href={href} target="_blank" rel="noreferrer">
            <CapiroTooltip content={e.quote ?? e.sourceUrl ?? label}>
              <CapiroBadge tone="success">{label}</CapiroBadge>
            </CapiroTooltip>
          </a>
        ) : (
          <CapiroBadge key={`${label}-${i}`}>{label}</CapiroBadge>
        );
      })}
    </span>
  );
}

export function VNextProgramMatchQueuePage({ standalone = false }: { standalone?: boolean }) {
  const api = useApi();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();
  const isCapiroAdmin = me.data?.role === 'capiro_admin';

  const [status, setStatus] = useState<StatusFilter>('candidate');
  const [pending, setPending] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const sort = useSvSort<'score'>('score', 'desc');

  const queue = useQuery({
    queryKey: ['program-match-queue', status],
    enabled: isCapiroAdmin,
    queryFn: () => getProgramMatchQueue(api, status, 200),
    staleTime: 30_000,
  });

  const resolve = useMutation({
    mutationFn: (vars: { id: string; decision: ProgramMatchDecision; notes?: string }) =>
      resolveProgramMatch(api, vars.id, vars.decision, vars.notes),
    onMutate: (vars) => setPending(vars.id),
    onSuccess: (_res, vars) => {
      toast.success(
        vars.decision === 'accept'
          ? 'Accepted — the match now shows on the PE Programs panel.'
          : vars.decision === 'reject'
            ? 'Rejected — the match is removed.'
            : 'Quarantined — held back from the PE profile.',
      );
      void qc.invalidateQueries({ queryKey: ['program-match-queue'] });
      // The PE profile "Programs" panel reads getProgramsForPe; refresh it too.
      void qc.invalidateQueries({ queryKey: ['program-element-programs'] });
    },
    onError: (e: unknown) => toast.error(`Resolve failed: ${(e as Error).message}`),
    onSettled: () => setPending(null),
  });

  const rows = useMemo(() => {
    const data = queue.data?.data ?? [];
    // Default: score desc (canonical defaultSortOrder='descend' on Confidence).
    const sorted = [...data].sort((a, b) => (sort.dir === 'desc' ? b.score - a.score : a.score - b.score));
    return sorted;
  }, [queue.data, sort.dir]);
  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(rows, 25);

  const frame = (content: JSX.Element) =>
    standalone ? (
      <div className="settings-vnext amx">
        <header className="stv-header">
          <div>
            <h1>Program Match Review Queue</h1>
            <p>Machine-proposed PE→Program links awaiting review.</p>
          </div>
        </header>
        <div className="stv-body">{content}</div>
      </div>
    ) : (
      content
    );

  if (me.isLoading) {
    return frame(
      <div className="stv-stack" aria-label="Loading">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>,
    );
  }
  if (!isCapiroAdmin) {
    return frame(
      <CapiroErrorState
        title="403"
        description="The program match queue is restricted to Capiro administrators."
      />,
    );
  }

  return frame(
    <SvCard
      title="Program Match Review Queue"
      description="Machine-proposed PE→Program links awaiting review. Each row shows why it matched, the source evidence, and a confidence band. Accept to surface it on the PE profile, quarantine to hold it back, or reject to discard it. Nothing is applied automatically; every decision is audit-logged."
    >
      <div className="stv-stack">
        <div className="stv-row">
          <span style={{ minWidth: 200 }}>
            <CapiroSelect
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              options={[
                { value: 'candidate', label: 'Candidates' },
                { value: 'quarantined', label: 'Quarantined' },
                { value: 'all', label: 'Candidates + quarantined' },
              ]}
            />
          </span>
        </div>

        {queue.isError ? (
          <SvCallout kind="error" title="Failed to load the program match queue." />
        ) : null}

        {queue.isLoading ? (
          <div className="stv-stack" aria-label="Loading program match queue">
            <CapiroSkeleton height={16} />
            <CapiroSkeleton height={16} width="70%" />
          </div>
        ) : rows.length === 0 ? (
          <CapiroEmptyState
            title={`No ${status === 'all' ? 'candidate or quarantined' : status} matches.`}
          />
        ) : (
          <>
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>Program</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Program Element</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>
                      <SvSortHeader
                        label="Confidence"
                        active={sort.key === 'score'}
                        dir={sort.dir}
                        onToggle={() => sort.toggle('score')}
                      />
                    </CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Why shown</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Evidence</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Notes</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Action</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {pageRows.map((r: ProgramMatchQueueRow) => (
                    <tr key={r.id}>
                      <CapiroTableCell>
                        <span className="stv-strong">
                          {r.program?.canonicalName ?? '(unknown program)'}
                        </span>
                        <div className="amx-cell-sub">
                          {[r.program?.mdapCode ? `MDAP ${r.program.mdapCode}` : null, r.program?.component]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </div>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <span className="stv-code">{r.peCode}</span>
                        {r.projectCode ? (
                          <CapiroBadge style={{ marginLeft: 6 }}>{r.projectCode}</CapiroBadge>
                        ) : null}
                        <div className="amx-cell-sub">
                          {r.programElement?.title ?? ''}
                          {r.programElement?.service ? ` (${r.programElement.service})` : ''}
                        </div>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <CapiroTooltip content={`score ${r.score.toFixed(2)} · tier ${r.evidenceTier}`}>
                          {bandBadge(r.confidenceBand)}
                        </CapiroTooltip>
                      </CapiroTableCell>
                      <CapiroTableCell>
                        {r.whyShown ? <span>{r.whyShown}</span> : <span className="stv-muted">—</span>}
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <EvidenceLinks evidence={r.evidence} />
                      </CapiroTableCell>
                      <CapiroTableCell>{statusBadge(r.status)}</CapiroTableCell>
                      <CapiroTableCell>
                        {/* Bare primitive-styled input: the column header carries the visible
                            label; the per-row aria-label matches canonical (`notes <id>`). */}
                        <input
                          className="capiro-input amx-notes-input"
                          placeholder="Optional"
                          aria-label={`notes ${r.id}`}
                          value={notesById[r.id] ?? ''}
                          onChange={(e) =>
                            setNotesById((prev) => ({ ...prev, [r.id]: e.target.value }))
                          }
                        />
                      </CapiroTableCell>
                      <CapiroTableCell>
                        <span className="amx-inline-actions">
                          <CapiroButton
                            size="compact"
                            variant="primary"
                            loading={pending === r.id}
                            onClick={() =>
                              confirm({
                                title: 'Accept this match?',
                                body: 'Marks the PE→Program link accepted; it shows on the PE Programs panel.',
                                okText: 'Accept',
                                onOk: () =>
                                  resolve.mutateAsync({
                                    id: r.id,
                                    decision: 'accept',
                                    notes: notesById[r.id],
                                  }),
                              })
                            }
                          >
                            Accept
                          </CapiroButton>
                          <CapiroButton
                            size="compact"
                            loading={pending === r.id}
                            onClick={() =>
                              confirm({
                                title: 'Quarantine this match?',
                                body: 'Holds it back from the PE profile; it stays in the queue.',
                                okText: 'Quarantine',
                                onOk: () =>
                                  resolve.mutateAsync({
                                    id: r.id,
                                    decision: 'quarantine',
                                    notes: notesById[r.id],
                                  }),
                              })
                            }
                          >
                            Quarantine
                          </CapiroButton>
                          <CapiroButton
                            size="compact"
                            className="stv-btn-danger"
                            loading={pending === r.id}
                            onClick={() =>
                              confirm({
                                title: 'Reject this match?',
                                body: 'Discards the proposed link.',
                                okText: 'Reject',
                                danger: true,
                                onOk: () =>
                                  resolve.mutateAsync({
                                    id: r.id,
                                    decision: 'reject',
                                    notes: notesById[r.id],
                                  }),
                              })
                            }
                          >
                            Reject
                          </CapiroButton>
                        </span>
                      </CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            <SvPagination currentPage={currentPage} pageCount={pageCount} onPage={setPage} />
          </>
        )}
      </div>
      {dialog}
    </SvCard>,
  );
}
