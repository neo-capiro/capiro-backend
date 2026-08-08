/**
 * Program Elements v2 — Actions surface.
 * Dense PE-scoped action table (ACTION · CLIENT · TRIGGER · OWNER · DUE ·
 * STATUS · EVIDENCE) over the same intelligence-actions list the legacy
 * ActionBoard renders. The shared /actions page keeps its own List default —
 * this is only the PE-embedded view.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from 'antd';
import { useActionsList } from '../../actions/actions-api.js';
import { STATUS_LABELS, type ActionStatus } from '../../actions/types.js';

const GRID = 'minmax(300px,1fr) 168px 150px 118px 128px 176px';

function statusCls(status: ActionStatus): string {
  if (status === 'dismissed' || status === 'archived') return 'neutral';
  if (status === 'new' || status === 'triaged') return 'ink';
  return 'neutral';
}

export function PeV2Actions() {
  const navigate = useNavigate();
  const actions = useActionsList({ page: 1, limit: 100 });

  const rows = useMemo(
    () => (actions.data?.data ?? []).filter((a) => a.peCode != null),
    [actions.data],
  );
  const blocked = rows.filter((a) => (a.uncertainty ?? '').toLowerCase().includes('conflict')).length;

  return (
    <div data-screen-label="Actions">
      <div className="pe-v2-page-head">
        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="pe-v2-page-title">Actions</div>
          <div className="pe-v2-page-sub">
            Government-affairs actions tied to monitored budget changes. These are the same records as the
            Engagement actions queue, filtered to Program Elements triggers.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', paddingTop: 6 }}>
          <button type="button" className="pe-v2-quiet-link" onClick={() => navigate('/actions')}>
            Open in Engagement ↗
          </button>
          <button type="button" className="pe-v2-btn pe-v2-btn-primary" onClick={() => navigate('/actions')}>
            Create action
          </button>
        </div>
      </div>

      <div style={{ background: '#fff' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1120 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: GRID,
                columnGap: 12,
                padding: '9px 24px',
                borderBottom: '1px solid var(--pev2-border-strong)',
                background: 'var(--pev2-canvas)',
                fontFamily: 'var(--pev2-mono)',
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--pev2-secondary)',
              }}
            >
              <div style={{ color: 'var(--pev2-ink)', fontWeight: 600 }}>Action</div>
              <div>Client</div>
              <div>Line</div>
              <div>Due</div>
              <div>Status</div>
              <div>Evidence</div>
            </div>
            {actions.isLoading ? (
              <div style={{ padding: 24 }}>
                <Skeleton active paragraph={{ rows: 5 }} />
              </div>
            ) : rows.length === 0 ? (
              <div className="pe-v2-empty" style={{ padding: '32px 24px' }}>
                No Program-Elements-triggered actions in the queue.
              </div>
            ) : (
              rows.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() =>
                    a.peCode
                      ? navigate(`/program-elements/${encodeURIComponent(a.peCode)}?tab=legislative`)
                      : navigate('/actions')
                  }
                  style={{
                    display: 'grid',
                    gridTemplateColumns: GRID,
                    columnGap: 12,
                    padding: '12px 24px',
                    borderBottom: '1px solid var(--pev2-hairline)',
                    alignItems: 'center',
                    cursor: 'pointer',
                    background: '#fff',
                    width: '100%',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: 'var(--pev2-ink)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {a.issueTitle}
                    </span>
                    <span className="pe-v2-mono" style={{ display: 'block', fontSize: 11, color: 'var(--pev2-secondary)', marginTop: 3 }}>
                      {a.actionType.replaceAll('_', ' ').toUpperCase()}
                    </span>
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--pev2-ink-2)' }}>{a.clientName ?? '—'}</span>
                  <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.05em', color: 'var(--pev2-ink)' }}>
                    {a.peCode ?? '—'}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--pev2-body)' }}>
                    {a.deadline ? new Date(a.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                  </span>
                  <span>
                    <span className={`pe-v2-ev-chip ${statusCls(a.status)}`}>
                      {(STATUS_LABELS[a.status] ?? a.status).toUpperCase()}
                    </span>
                  </span>
                  <span
                    className="pe-v2-mono"
                    style={{
                      fontSize: 11,
                      color: 'var(--pev2-secondary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {a.evidence?.length ? `${a.evidence.length} REF${a.evidence.length === 1 ? '' : 'S'}` : '—'}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="pe-v2-table-foot">
          {rows.length} ACTION{rows.length === 1 ? '' : 'S'}
          {blocked ? ` · ${blocked} BLOCKED BY AN UNRESOLVED EVIDENCE CONFLICT` : ''}
        </div>
      </div>
    </div>
  );
}
