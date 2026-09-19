import { useClerk } from '@clerk/clerk-react';

interface WorkspaceAccessErrorProps {
  status: 401 | 403;
  retrying: boolean;
  onRetry: () => void;
}

/**
 * Authenticated bootstrap stopped before the application shell mounted. Keep
 * this screen independent from either product shell so a tenant-resolution
 * failure cannot trigger the shell's data-query fan-out.
 */
export function WorkspaceAccessError({ status, retrying, onRetry }: WorkspaceAccessErrorProps) {
  const { signOut } = useClerk();
  const description =
    status === 401
      ? 'Your sign-in could not be verified. Sign out, then sign in again to continue.'
      : 'We could not verify access to a Capiro workspace. Ask your organization administrator to confirm your access.';

  return (
    <main
      aria-labelledby="workspace-access-title"
      style={{
        boxSizing: 'border-box',
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--capiro-color-bg-canvas, var(--bg-canvas, #f0f1f4))',
        color: 'var(--capiro-color-text-primary, var(--ink-1, #17181c))',
        fontFamily: 'var(--capiro-font-sans, var(--font-sans, Inter, sans-serif))',
      }}
    >
      <section
        role="alert"
        style={{
          boxSizing: 'border-box',
          width: 'min(100%, 480px)',
          padding: '40px 36px',
          border: '1px solid var(--capiro-color-border-default, var(--border-1, #d9dce3))',
          borderRadius: 10,
          background: 'var(--capiro-color-bg-surface, #fff)',
          boxShadow: '0 8px 30px rgba(21, 22, 26, 0.08)',
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 52,
            height: 52,
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto 18px',
            borderRadius: '50%',
            background: '#fef3f2',
            color: '#b42318',
            fontSize: 22,
            fontWeight: 700,
          }}
        >
          !
        </div>
        <h1
          id="workspace-access-title"
          style={{ margin: 0, fontSize: 26, lineHeight: 1.2, letterSpacing: '-0.015em' }}
        >
          We couldn&apos;t open your workspace
        </h1>
        <p style={{ margin: '12px 0 24px', color: '#475467', fontSize: 14, lineHeight: 1.6 }}>
          {description}
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            style={{
              width: '100%',
              padding: '10px 18px',
              border: '1px solid #315dfb',
              borderRadius: 6,
              background: '#315dfb',
              color: '#fff',
              cursor: retrying ? 'wait' : 'pointer',
              font: 'inherit',
              fontWeight: 600,
            }}
          >
            {retrying ? 'Checking access…' : 'Try again'}
          </button>
          <button
            type="button"
            onClick={() => void signOut({ redirectUrl: '/sign-in' })}
            style={{
              width: '100%',
              padding: '10px 18px',
              border: '1px solid #d0d5dd',
              borderRadius: 6,
              background: '#fff',
              color: '#344054',
              cursor: 'pointer',
              font: 'inherit',
              fontWeight: 600,
            }}
          >
            Sign out
          </button>
        </div>
        <p style={{ margin: '18px 0 0', color: '#667085', fontSize: 12.5, lineHeight: 1.5 }}>
          Need help? <a href="mailto:support@capiro.ai">Contact Capiro support</a>.
        </p>
      </section>
    </main>
  );
}
