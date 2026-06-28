import { ArrowLeftOutlined, CheckOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

export type WsStep = 'setup' | 'context' | 'draft' | 'preview';

const STEPS: { key: WsStep; label: string }[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'context', label: 'Build context' },
  { key: 'draft', label: 'Draft' },
  { key: 'preview', label: 'Preview & Save' },
];

/**
 * The persistent left steps rail — the spine of the document flow (ported from
 * the prototype wskit StepsRail). Lets the user move between Setup → Context →
 * Draft → Preview for a given draft.
 */
export function StepsRail({
  active,
  draftId,
  product,
  children,
}: {
  active: WsStep;
  draftId?: string;
  product?: string | null;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const idx = STEPS.findIndex((s) => s.key === active);

  const go = (step: WsStep) => {
    if (!draftId) return;
    navigate(`/workspace/${step}/${draftId}`);
  };

  return (
    <div className="ws-steps-rail">
      {/* Breadcrumb back to the Documents list — always available in the flow. */}
      <button
        onClick={() => navigate('/workspace/documents')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          border: 'none',
          background: 'none',
          cursor: 'pointer',
          padding: '0 6px',
          marginBottom: 14,
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ws-ink-3, var(--ink-3))',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <ArrowLeftOutlined style={{ fontSize: 11 }} />
        Documents
      </button>
      {product && (
        <div className="ws-kicker" style={{ marginBottom: 12, paddingLeft: 6 }}>
          {product}
        </div>
      )}
      {STEPS.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'todo';
        const on = i === idx;
        return (
          <div key={s.key}>
            <button
              className={`ws-step${on ? ' on' : ''}`}
              onClick={() => go(s.key)}
              disabled={!draftId}
            >
              <span className={`ws-step-num ${state}`}>
                {state === 'done' ? <CheckOutlined style={{ fontSize: 11 }} /> : i + 1}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: on ? 700 : 500,
                  color: state === 'todo' ? 'var(--ws-ink-3)' : 'var(--ws-ink-1)',
                }}
              >
                {s.label}
              </span>
            </button>
            {s.key === 'draft' && on && children}
          </div>
        );
      })}
    </div>
  );
}
