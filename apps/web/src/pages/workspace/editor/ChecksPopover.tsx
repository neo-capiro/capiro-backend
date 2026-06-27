/**
 * Pre-submission checks popover (Phase 6b) — ported from the prototype
 * `ChecksPopover` (asset_10). The static 8/10 score and hard-coded WS.checks
 * are replaced by the live rule-based evaluation from the engine
 * (useDraftChecks → GET /workspace-api/drafts/:id/checks). Non-success checks
 * offer a "Fix" affordance (a jump-to / toast stub). The 3 human sign-off gates
 * are listed below the checks and WARN, never block (LOCKED Q-PV-2).
 */
import { Spin } from 'antd';
import { Icon } from '../kit.js';
import type { WsCheckResult, WsCheckStatus, WsChecksResponse } from '../types.js';

const scoreColor = (passed: number, total: number): string => {
  if (total === 0) return 'var(--ink-3)';
  if (passed === total) return 'var(--success)';
  if (passed >= Math.ceil(total * 0.7)) return 'var(--notable)';
  return 'var(--critical)';
};

export function ChecksPopover({
  data,
  loading,
  onClose,
  onFix,
}: {
  data?: WsChecksResponse;
  loading?: boolean;
  onClose: () => void;
  onFix: (check: WsCheckResult) => void;
}) {
  const passed = data?.score.passed ?? 0;
  const total = data?.score.total ?? 0;
  return (
    <div style={{ position: 'absolute', top: 14, right: 18, width: 322, zIndex: 30 }}>
      <div className="card" style={{ boxShadow: 'var(--shadow-2)', overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '11px 14px',
            borderBottom: '1px solid var(--border-1)',
          }}
        >
          <Icon name="ListChecks" size={15} style={{ color: 'var(--ink-2)', marginRight: 8 }} />
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Pre-submission checks</span>
          <span
            className="num"
            style={{
              fontSize: 12,
              color: scoreColor(passed, total),
              fontWeight: 600,
              marginRight: 8,
            }}
          >
            {passed}/{total}
          </span>
          <button
            onClick={onClose}
            className="tb-iconbtn"
            style={{ width: 26, height: 26, border: 'none', background: 'transparent' }}
          >
            <Icon name="X" size={15} />
          </button>
        </div>

        <div style={{ maxHeight: 340, overflow: 'auto', padding: '4px 14px' }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: 20 }}>
              <Spin size="small" />
            </div>
          )}
          {!loading &&
            (data?.checks ?? []).map((c, i) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 0',
                  borderTop: i ? '1px solid var(--border-1)' : 'none',
                }}
              >
                <span className={'dot ' + statusClass(c.status)} style={{ width: 8, height: 8 }} />
                <span
                  style={{
                    fontSize: 12.5,
                    flex: 1,
                    color: c.status === 'success' ? 'var(--ink-2)' : 'var(--ink-1)',
                    fontWeight: c.status === 'success' ? 400 : 500,
                  }}
                >
                  {c.label}
                  {c.detail && (
                    <span className="num" style={{ color: 'var(--ink-4)', fontWeight: 400 }}>
                      {' '}
                      · {c.detail}
                    </span>
                  )}
                </span>
                {c.status !== 'success' && (
                  <a
                    onClick={() => onFix(c)}
                    style={{
                      fontSize: 11,
                      color: 'var(--accent)',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Fix
                  </a>
                )}
              </div>
            ))}

          {/* Human sign-off gates — WARN, never block (LOCKED Q-PV-2). */}
          {!loading && (data?.gates?.length ?? 0) > 0 && (
            <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 8, marginTop: 4 }}>
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  color: 'var(--ink-3)',
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                Human sign-off
              </div>
              {(data?.gates ?? []).map((g) => (
                <div
                  key={g.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}
                >
                  <Icon
                    name="ShieldCheck"
                    size={13}
                    style={{ color: g.status === 'success' ? 'var(--success)' : 'var(--notable)' }}
                  />
                  <span style={{ fontSize: 12, flex: 1, color: 'var(--ink-1)' }}>{g.label}</span>
                  <span className="pill muted" style={{ fontSize: 10 }}>
                    {g.status === 'success' ? 'signed' : 'pending'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '9px 14px',
            borderTop: '1px solid var(--border-1)',
            fontSize: 11,
            color: 'var(--ink-3)',
          }}
        >
          Meri checks the draft against committee rules &amp; house style as you write. Sign-off
          gates warn but never block.
        </div>
      </div>
    </div>
  );
}

function statusClass(s: WsCheckStatus): string {
  return s;
}
