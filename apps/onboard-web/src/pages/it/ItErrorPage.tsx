// IT Admin terminal page: the Microsoft/Google consent callbacks 302 to
// /it/error?reason=… when the grant did not land.
import { useSearchParams } from 'react-router-dom';
import { Card, Icon } from '../../ui/primitives';
import { ExtShell } from '../setup/ExtShell';

const REASON_TEXT: Record<string, string> = {
  state: 'The secure link was invalid or had expired.',
  missing: "We couldn't find your invite — it may have been replaced.",
  expired: 'This invite has expired. Ask your administrator to resend it.',
  declined: 'The authorization was declined before it completed.',
  // Google-only reasons (the test-connect verification path):
  policy:
    'Your Google Workspace is blocking Capiro. In the Google Admin console, open Security → API controls → App access control, mark Capiro as Trusted, then retry from the link in your email.',
  scopes:
    'Not every permission was granted. Retry from the link in your email and leave all requested permissions checked.',
  account:
    "That Google account isn't on your firm's domain. Sign in with your organization's Google Workspace admin account — the one that matches the email your invite was sent to.",
  exchange: 'Google sign-in could not be completed. Retry from the link in your email.',
};

export function ItErrorPage() {
  const [params] = useSearchParams();
  const reason = params.get('reason') ?? '';
  const detail = REASON_TEXT[reason] ?? 'The connection could not be verified.';

  return (
    <ExtShell>
      <div style={{ maxWidth: 480, margin: '40px auto 0' }}>
        <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'var(--critical-soft)',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 18px',
            }}
          >
            <Icon name="TriangleAlert" size={23} style={{ color: 'var(--critical)' }} />
          </div>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-serif)',
              fontWeight: 500,
              fontSize: 25,
              letterSpacing: '-0.015em',
              lineHeight: 1.25,
            }}
          >
            We couldn't verify the connection
          </h1>
          <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            {detail}
          </p>
          <div style={{ marginTop: 18, fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
            You can close this window and use the link in your email to retry.
          </div>
        </Card>
      </div>
    </ExtShell>
  );
}
