/**
 * Program Elements vNext — Actions surface (native port of
 * src/pages/program-element/v2/PeV2Actions.tsx).
 * Dense PE-scoped action table (ACTION · CLIENT · TRIGGER · OWNER · DUE ·
 * STATUS · EVIDENCE) over the same intelligence-actions list the legacy
 * ActionBoard renders. The shared /actions page keeps its own List default —
 * this is only the PE-embedded view.
 *
 * Phase 4 polish: `CapiroTable` + `CapiroBadge` + `CapiroButton`; same query
 * hook, same peCode filter, same columns, same copy.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useActionsList } from '../../../pages/actions/actions-api.js';
import { STATUS_LABELS, type ActionStatus } from '../../../pages/actions/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { PeSkeletonBlock } from './pe-primitives.js';

/**
 * Status tone. Mirrors the Phase 3 `statusCls` mapping exactly — `new`/`triaged`
 * are the loud (ink) states, everything else is quiet — only the vocabulary
 * moved from a local chip class to the CapiroBadge tone scale.
 */
function statusTone(status: ActionStatus): CapiroBadgeTone {
  if (status === 'dismissed' || status === 'archived') return 'neutral';
  if (status === 'new' || status === 'triaged') return 'info';
  return 'neutral';
}

export function PeActionsView() {
  const navigate = useNavigate();
  const actions = useActionsList({ page: 1, limit: 100 });

  const rows = useMemo(
    () => (actions.data?.data ?? []).filter((a) => a.peCode != null),
    [actions.data],
  );
  const blocked = rows.filter((a) => (a.uncertainty ?? '').toLowerCase().includes('conflict')).length;

  return (
    <div data-screen-label="Actions" className="pe-ws-view">
      <div className="pe-v2-page-head">
        <div className="pe-ws-head__text">
          <div className="pe-v2-page-title">Actions</div>
          <div className="pe-v2-page-sub">
            Government-affairs actions tied to monitored budget changes. These are the same records as the
            Engagement actions queue, filtered to Program Elements triggers.
          </div>
        </div>
        <div className="pe-ws-head__actions">
          <CapiroButton size="compact" variant="quiet" onClick={() => navigate('/actions')}>
            Open in Engagement ↗
          </CapiroButton>
          <CapiroButton size="compact" variant="primary" onClick={() => navigate('/actions')}>
            Create action
          </CapiroButton>
        </div>
      </div>

      <div className="pe-ws-body">
        <section className="pe-v2-card pe-ws-tablecard">
          {actions.isLoading ? (
            <div className="pe-ws-pad">
              <PeSkeletonBlock rows={5} />
            </div>
          ) : rows.length === 0 ? (
            <div className="pe-ws-pad pe-ws-pad--tall">
              <CapiroEmptyState title="No Program-Elements-triggered actions in the queue." />
            </div>
          ) : (
            <CapiroTableWrap className="pe-ws-tablescroll">
              <CapiroTable className="pe-ws-table">
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell className="pe-ws-col-id">Action</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Client</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Line</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Due</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Evidence</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {rows.map((a) => {
                    const open = () =>
                      a.peCode
                        ? navigate(`/program-elements/${encodeURIComponent(a.peCode)}?tab=legislative`)
                        : navigate('/actions');
                    return (
                      <tr key={a.id} className="pe-ws-row pe-ws-row--link" onClick={open}>
                        <CapiroTableCell className="pe-ws-col-id">
                          <button
                            type="button"
                            className="pe-ws-idbtn"
                            onClick={(event) => {
                              event.stopPropagation();
                              open();
                            }}
                          >
                            <span className="pe-ws-title">{a.issueTitle}</span>
                            <span className="pe-ws-code">
                              {a.actionType.replaceAll('_', ' ').toUpperCase()}
                            </span>
                          </button>
                        </CapiroTableCell>
                        <CapiroTableCell>{a.clientName ?? '—'}</CapiroTableCell>
                        <CapiroTableCell className="pe-ws-meta pe-ws-meta--ink">{a.peCode ?? '—'}</CapiroTableCell>
                        <CapiroTableCell>
                          {a.deadline
                            ? new Date(a.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                            : '—'}
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <CapiroBadge tone={statusTone(a.status)}>
                            {(STATUS_LABELS[a.status] ?? a.status).toUpperCase()}
                          </CapiroBadge>
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-meta">
                          {a.evidence?.length ? `${a.evidence.length} REF${a.evidence.length === 1 ? '' : 'S'}` : '—'}
                        </CapiroTableCell>
                      </tr>
                    );
                  })}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
          )}
          <div className="pe-v2-table-foot">
            {rows.length} ACTION{rows.length === 1 ? '' : 'S'}
            {blocked ? ` · ${blocked} BLOCKED BY AN UNRESOLVED EVIDENCE CONFLICT` : ''}
          </div>
        </section>
      </div>
    </div>
  );
}
