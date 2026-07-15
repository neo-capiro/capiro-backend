// IT Admin path (/it/:token) — same URL, single-task view. Port of the
// prototype ItAdminView: the emailed token IS the credential (no Clerk
// account). Microsoft goes to the Entra admin-consent URL. Google has no
// admin-consent URL — its flow (decision Q5, unblocked by the shipped Gmail
// integration) is: allowlist the Capiro client as a Trusted app in the Google
// Admin console, then verify with an OAuth test-connect. Either provider
// renders disabled ("Coming soon") when the deployment isn't configured for
// it — fail-closed dark.
import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn, Card, GGlyph, Icon, MsGlyph, Spinner, Tag } from '../../ui/primitives';
import { ErrorText, errorMessage } from '../funnel/shared';
import { fetchItConsentUrl, fetchItInvite, skipItGoogleVerification } from '../../lib/setup';
import { ExtShell } from '../setup/ExtShell';
import { ItConnectionSkippedCard, ItConnectionVerifiedCard } from './ItDonePage';

export function ItAdminPage() {
  const { token = '' } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const invite = useQuery({
    queryKey: ['it', 'invite', token],
    queryFn: () => fetchItInvite(token),
    retry: false,
  });

  const [view, setView] = React.useState<'choose' | 'google'>('choose');
  const [phase, setPhase] = React.useState<'idle' | 'connecting' | 'skipping'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const connect = async (provider: 'microsoft' | 'google') => {
    if (phase !== 'idle') return;
    setPhase('connecting');
    setError(null);
    try {
      const { url } = await fetchItConsentUrl(token, provider);
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setPhase('idle');
    }
  };

  const skipGoogle = async () => {
    if (phase !== 'idle') return;
    setPhase('skipping');
    setError(null);
    try {
      await skipItGoogleVerification(token);
      await queryClient.invalidateQueries({ queryKey: ['it', 'invite', token] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPhase('idle');
    }
  };

  const copyClientId = async (clientId: string) => {
    try {
      await navigator.clipboard.writeText(clientId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions/insecure context) — the id
      // stays selectable in the box, so failing silently is fine.
    }
  };

  if (invite.isLoading) {
    return (
      <ExtShell>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <Spinner size={18} />
        </div>
      </ExtShell>
    );
  }

  // Invalid/expired/revoked token (404/403) — Gherkin edge case.
  if (invite.error || !invite.data) {
    return (
      <ExtShell>
        <div style={{ maxWidth: 480, margin: '40px auto 0' }}>
          <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-1)', fontWeight: 600 }}>
              Invite expired, contact your administrator
            </p>
          </Card>
        </div>
      </ExtShell>
    );
  }

  const S = invite.data;
  const done = S.status === 'granted' || S.status === 'verified';
  const skipped = S.status === 'skipped';
  // Older cached responses may lack `providers` — default to the pre-Google
  // behavior (Microsoft on, Google off).
  const providers = S.providers ?? { microsoft: true, google: false };

  return (
    <ExtShell orgName={S.orgName}>
      {done ? (
        <ItConnectionVerifiedCard />
      ) : skipped ? (
        <ItConnectionSkippedCard />
      ) : (
        <div style={{ maxWidth: 480, margin: '40px auto 0' }}>
          <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: 'var(--accent-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 18px',
              }}
            >
              <Icon name="Plug" size={23} style={{ color: 'var(--accent)' }} />
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
              Connect {S.orgName}'s email to Capiro
            </h1>
            {view === 'choose' && (
              <p
                style={{
                  margin: '10px 0 24px',
                  fontSize: 13,
                  color: 'var(--ink-2)',
                  lineHeight: 1.6,
                  textWrap: 'pretty',
                }}
              >
                Signing in with your org admin credentials will authorize all team members to
                connect their individual accounts.
              </p>
            )}
            {phase === 'connecting' || phase === 'skipping' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  fontSize: 13,
                  color: 'var(--ink-2)',
                  padding: '12px 0',
                }}
              >
                <Spinner size={16} />
                {phase === 'skipping' ? 'Saving…' : 'Authorizing with your provider…'}
              </div>
            ) : view === 'google' ? (
              <div style={{ textAlign: 'left', marginTop: 14 }}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                  <b style={{ color: 'var(--ink-1)' }}>1.</b> In the Google Admin console, open{' '}
                  <b style={{ color: 'var(--ink-1)' }}>
                    Security → API controls → App access control
                  </b>{' '}
                  and add Capiro as a <b style={{ color: 'var(--ink-1)' }}>Trusted</b> app using
                  this client ID:
                </p>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    margin: '10px 0 16px',
                    padding: '8px 10px',
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 8,
                  }}
                >
                  <code
                    style={{
                      flex: 1,
                      fontSize: 11,
                      color: 'var(--ink-1)',
                      wordBreak: 'break-all',
                      lineHeight: 1.5,
                    }}
                  >
                    {S.googleClientId}
                  </code>
                  <Btn
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyClientId(S.googleClientId ?? '')}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Btn>
                </div>
                <p
                  style={{
                    margin: '0 0 16px',
                    fontSize: 13,
                    color: 'var(--ink-2)',
                    lineHeight: 1.6,
                  }}
                >
                  <b style={{ color: 'var(--ink-1)' }}>2.</b> Verify the connection by signing in
                  with your Google Workspace admin account. If your Workspace already allows
                  third-party apps, you can verify right away.
                </p>
                <div style={{ display: 'grid', gap: 10 }}>
                  <Btn
                    variant="secondary"
                    size="lg"
                    onClick={() => void connect('google')}
                    style={{ width: '100%' }}
                  >
                    <GGlyph /> Verify with Google
                  </Btn>
                  <Btn
                    variant="ghost"
                    size="sm"
                    onClick={() => setView('choose')}
                    style={{ width: '100%' }}
                  >
                    Back
                  </Btn>
                </div>
                <p
                  style={{
                    margin: '14px 0 0',
                    textAlign: 'center',
                    fontSize: 12,
                    color: 'var(--ink-3)',
                  }}
                >
                  Workspace policy in the way, or not ready?{' '}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void skipGoogle();
                    }}
                    style={{ color: 'var(--accent)' }}
                  >
                    Skip for now — connect later
                  </a>
                </p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                <Btn
                  variant="secondary"
                  size="lg"
                  disabled={!providers.microsoft}
                  onClick={() => void connect('microsoft')}
                  style={{ width: '100%' }}
                >
                  <MsGlyph /> Connect with Microsoft
                </Btn>
                {providers.google ? (
                  <Btn
                    variant="secondary"
                    size="lg"
                    onClick={() => setView('google')}
                    style={{ width: '100%' }}
                  >
                    <GGlyph /> Connect with Google
                  </Btn>
                ) : (
                  <Btn variant="secondary" size="lg" disabled style={{ width: '100%' }}>
                    <GGlyph /> Connect with Google <Tag tone="neutral">Coming soon</Tag>
                  </Btn>
                )}
              </div>
            )}
            {error && <ErrorText>{error}</ErrorText>}
            <div style={{ marginTop: 18, fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              Org-wide grant only — Capiro never reads mailboxes until each user opts in
              individually.
            </div>
          </Card>
        </div>
      )}
    </ExtShell>
  );
}
