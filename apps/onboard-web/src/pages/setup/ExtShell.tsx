// Flow-2A Environment-2 chrome: ExtShell + TaskStatus + TaskCard, a 1:1 port
// of prototype/03-flow2a-it.jsx (styles verbatim; EnvBar deliberately dropped).
import type React from 'react';
import { Card, Icon, Spinner, Tag, Wordmark } from '../../ui/primitives';

/**
 * Environment-2 page shell: minimal chrome, wordmark + org name, support link.
 * `orgName` is optional so the standalone IT terminal pages (/it/done, /it/error
 * — no invite context) can render the same shell without a firm name.
 */
export function ExtShell({
  orgName,
  children,
}: {
  orgName?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-canvas)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 40px',
          borderBottom: '1px solid var(--border-1)',
          background: '#fff',
        }}
      >
        <Wordmark />
        {orgName ? (
          <>
            <span style={{ width: 1, height: 16, background: 'var(--border-2)' }}></span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}>
              {orgName} Setup
            </span>
          </>
        ) : null}
        <span style={{ flex: 1 }}></span>
        <a
          href="mailto:support@capiro.ai"
          style={{
            fontSize: 12,
            color: 'var(--ink-3)',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Icon name="LifeBuoy" size={13} />
          Need help? <span style={{ color: 'var(--accent)' }}>support@capiro.ai</span>
        </a>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '36px 40px 64px',
        }}
      >
        <div style={{ width: '100%', maxWidth: 720 }}>{children}</div>
      </div>
    </div>
  );
}

export type TaskCardStatus = 'none' | 'waiting' | 'verifying' | 'progress' | 'done' | 'locked';

export function TaskStatus({ s }: { s: TaskCardStatus }) {
  if (s === 'done')
    return (
      <Tag tone="success">
        <Icon name="Check" size={10} strokeWidth={3} />
        Complete
      </Tag>
    );
  if (s === 'progress') return <Tag tone="blue">In progress</Tag>;
  if (s === 'verifying')
    return (
      <Tag tone="blue">
        <Spinner size={9} color="var(--accent-ink)" />
        Verifying
      </Tag>
    );
  if (s === 'waiting') return <Tag tone="notable">Waiting on IT Admin</Tag>;
  if (s === 'locked')
    return (
      <Tag tone="neutral">
        <Icon name="Lock" size={10} />
        Locked
      </Tag>
    );
  return <Tag tone="neutral">Not started</Tag>;
}

export function TaskCard({
  num,
  title,
  desc,
  status,
  locked,
  action,
  children,
}: {
  num: string;
  title: React.ReactNode;
  desc: React.ReactNode;
  status: TaskCardStatus;
  locked?: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card pad={0} style={{ opacity: locked ? 0.55 : 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '16px 20px' }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            background: status === 'done' ? 'var(--success-soft)' : 'var(--bg-sunken)',
            color: status === 'done' ? 'var(--success)' : 'var(--ink-2)',
            border: '1px solid var(--border-1)',
          }}
        >
          {status === 'done' ? (
            <Icon name="Check" size={13} strokeWidth={3} />
          ) : locked ? (
            <Icon name="Lock" size={12} />
          ) : (
            num
          )}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 14, letterSpacing: '-0.005em' }}>{title}</b>
            <TaskStatus s={status} />
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--ink-2)',
              marginTop: 3,
              lineHeight: 1.5,
              textWrap: 'pretty',
            }}
          >
            {desc}
          </div>
        </div>
        {action && <div style={{ flexShrink: 0 }}>{action}</div>}
      </div>
      {children && (
        <div
          style={{
            borderTop: '1px solid var(--border-1)',
            padding: '14px 20px',
            background: 'var(--bg-surface-2)',
          }}
        >
          {children}
        </div>
      )}
    </Card>
  );
}
