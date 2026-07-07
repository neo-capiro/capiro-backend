// IT Admin path (/it/:token) — same URL, single-task view. Port of the
// prototype ItAdminView: the emailed token IS the credential (no Clerk
// account), Microsoft goes to the Entra admin-consent URL, Google is deferred
// (decision Q5 — rendered disabled with a Coming soon tag).
import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Btn, Card, GGlyph, Icon, MsGlyph, Spinner, Tag } from '../../ui/primitives';
import { ErrorText, errorMessage } from '../funnel/shared';
import { fetchItConsentUrl, fetchItInvite } from '../../lib/setup';
import { ExtShell } from '../setup/ExtShell';
import { ItConnectionVerifiedCard } from './ItDonePage';

export function ItAdminPage() {
  const { token = '' } = useParams<{ token: string }>();
  const invite = useQuery({
    queryKey: ['it', 'invite', token],
    queryFn: () => fetchItInvite(token),
    retry: false,
  });

  const [phase, setPhase] = React.useState<'idle' | 'connecting'>('idle');
  const [error, setError] = React.useState<string | null>(null);

  const connect = async () => {
    if (phase === 'connecting') return;
    setPhase('connecting');
    setError(null);
    try {
      const { url } = await fetchItConsentUrl(token, 'microsoft');
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setPhase('idle');
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

  return (
    <ExtShell orgName={S.orgName}>
      {done ? (
        <ItConnectionVerifiedCard />
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
            <p
              style={{
                margin: '10px 0 24px',
                fontSize: 13,
                color: 'var(--ink-2)',
                lineHeight: 1.6,
                textWrap: 'pretty',
              }}
            >
              Signing in with your org admin credentials will authorize all team members to connect
              their individual accounts.
            </p>
            {phase === 'connecting' ? (
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
                Authorizing with your provider…
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                <Btn
                  variant="secondary"
                  size="lg"
                  onClick={() => void connect()}
                  style={{ width: '100%' }}
                >
                  <MsGlyph /> Connect with Microsoft
                </Btn>
                {/* Google is deferred (decision Q5): rendered exactly, but disabled. */}
                <Btn variant="secondary" size="lg" disabled style={{ width: '100%' }}>
                  <GGlyph /> Connect with Google <Tag tone="neutral">Coming soon</Tag>
                </Btn>
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
