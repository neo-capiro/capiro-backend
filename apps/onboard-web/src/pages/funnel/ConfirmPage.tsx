// 1.10 Confirmation + provisioning bridge — F1Confirm (prototype/02-flow1.jsx).
// The three timed lines are real: POST /funnel/provision once on mount, then
// poll GET /funnel/status every 1.5s. Line 1 completes when a tenant exists;
// lines 2 and 3 complete (visually staggered 600ms apart) once provisioned.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Card, FunnelShell, Icon, InfoBlock, Spinner, Tag } from '../../ui/primitives';
import {
  formatLongDate,
  useAdvanceSession,
  useFunnelApi,
  useFunnelSession,
  type FunnelSession,
} from '../../lib/funnel';

export function ConfirmPage() {
  const session = useFunnelSession();
  if (!session.data) return null;
  return <F1Confirm session={session.data} />;
}

function F1Confirm({ session }: { session: FunnelSession }) {
  const navigate = useNavigate();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();

  // 0..3 = bridge lines, 4 = revealed (prototype phases).
  const [phase, setPhase] = React.useState(0);
  const [failureReason, setFailureReason] = React.useState<string | null>(
    session.state === 'failed' ? 'Provisioning failed.' : null,
  );

  const provisionFiredRef = React.useRef(false); // guards the StrictMode double-mount
  const initialStateRef = React.useRef(session.state);

  React.useEffect(() => {
    let stopped = false;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(fn, ms));
    };

    void (async () => {
      if (!provisionFiredRef.current) {
        provisionFiredRef.current = true;
        if (initialStateRef.current === 'org_setup') {
          try {
            await api.provision();
          } catch {
            // Provision may 502 on failure — the status poll below surfaces it.
          }
        }
      }
      const poll = async () => {
        if (stopped) return;
        try {
          const status = await api.getStatus();
          if (stopped) return;
          if (status.tenantId || status.state === 'provisioned') {
            setPhase((p) => Math.max(p, 1));
          }
          if (status.state === 'provisioned') {
            advanceSession({
              state: 'provisioned',
              tenantId: status.tenantId,
              slugFinal: status.slug,
            });
            setPhase((p) => Math.max(p, 2));
            later(() => setPhase((p) => Math.max(p, 3)), 600);
            later(() => setPhase(4), 1300);
            return;
          }
          if (status.state === 'failed') {
            setFailureReason(status.failureReason || 'Provisioning failed.');
            return;
          }
        } catch {
          // transient poll error — keep trying
        }
        later(() => void poll(), 1500);
      };
      void poll();
    })();

    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines: [string, string][] = [
    ['Creating workspace…', 'Done'],
    ['Running health check…', 'Stable'],
    ['Sending invites…', 'Sent'],
  ];
  const designations = session.roleDesignations ?? [];
  const admins =
    session.roleMode === 'self'
      ? [`${session.email} (Super Admin)`]
      : designations
          .filter((v) => v.email)
          .map((v) => `${v.email} (${v.role === 'super' ? 'Super Admin' : 'Admin'})`);
  const itAdminEmail = session.itAdminEmails?.length ? session.itAdminEmails.join(' · ') : null;
  const price = (Math.max(10, session.profiles ?? 10) * 200).toLocaleString();
  const receipt =
    session.plan === 'trial' ? (
      <>
        $0 charged today · Trial begins when firm setup completes · then <b>$2,000/mo</b> ·{' '}
        {session.payMethod === 'card'
          ? 'Card on file'
          : session.payMethod === 'wire'
            ? 'Billed by wire'
            : 'Billed by ACH'}
      </>
    ) : session.payMethod === 'card' ? (
      <>
        Receipt: <b>${price}</b> charged · {formatLongDate(new Date())} · card on file
      </>
    ) : (
      <>
        Invoice sent to <b>{session.email}</b> · Amount due: <b>${price}</b> ·{' '}
        {session.payMethod === 'wire'
          ? 'Wire instructions emailed'
          : 'ACH debit initiated — 1–3 days to clear'}
      </>
    );

  return (
    <FunnelShell step={8} maxWidth={560}>
      <Card style={{ textAlign: 'center', padding: '40px 36px' }}>
        {failureReason ? (
          <>
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
              <Icon name="TriangleAlert" size={24} style={{ color: 'var(--critical)' }} />
            </div>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 26,
                letterSpacing: '-0.015em',
              }}
            >
              We couldn't provision your workspace
            </h1>
            <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              <span style={{ color: 'var(--critical)' }}>{failureReason}</span>
              <br />
              Contact{' '}
              <a href="mailto:support@capiro.ai" style={{ color: 'var(--accent)' }}>
                support@capiro.ai
              </a>{' '}
              and we'll get your firm set up.
            </p>
          </>
        ) : phase < 4 ? (
          <>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: 'var(--accent-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 20px',
              }}
            >
              <Spinner size={22} />
            </div>
            <h1
              style={{
                margin: '0 0 22px',
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 24,
                letterSpacing: '-0.015em',
              }}
            >
              Provisioning your workspace
            </h1>
            <div
              style={{
                display: 'grid',
                gap: 10,
                maxWidth: 320,
                margin: '0 auto',
                textAlign: 'left',
              }}
            >
              {lines.map(([label, done], i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 13,
                    color: phase > i ? 'var(--ink-1)' : 'var(--ink-3)',
                  }}
                >
                  {phase > i ? (
                    <Icon name="CircleCheck" size={16} style={{ color: 'var(--success)' }} />
                  ) : phase === i ? (
                    <Spinner />
                  ) : (
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        border: '1.5px solid var(--border-strong)',
                        display: 'inline-block',
                      }}
                    ></span>
                  )}
                  <span style={{ flex: 1 }}>{label}</span>
                  {phase > i && (
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--success)' }}>
                      ✓ {done}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: 'var(--success-soft)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 18px',
              }}
            >
              <Icon name="Check" size={26} strokeWidth={2.6} style={{ color: 'var(--success)' }} />
            </div>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--font-serif)',
                fontWeight: 500,
                fontSize: 26,
                letterSpacing: '-0.015em',
              }}
            >
              {session.plan === 'trial'
                ? 'Your workspace is live.'
                : 'Payment confirmed — your workspace is live.'}
            </h1>
            <p
              style={{
                margin: '8px 0 22px',
                fontSize: 13,
                color: 'var(--ink-2)',
                lineHeight: 1.55,
              }}
            >
              Your firm's workspace is ready at{' '}
              <b style={{ fontFamily: 'var(--font-mono)', letterSpacing: 0, fontSize: 12.5 }}>
                app.capiro.ai
              </b>{' '}
              — but setup isn't finished. Your admins take it from here.
              {session.plan === 'trial' && (
                <>
                  <br />
                  Your{' '}
                  <b style={{ color: 'var(--ink-1)' }}>
                    30-day free trial begins the day your firm finishes setting up its workspace
                  </b>{' '}
                  — not today.
                </>
              )}
            </p>
            <div style={{ display: 'grid', gap: 10, textAlign: 'left' }}>
              <InfoBlock
                icon="Server"
                title="Platform created"
                tag={<Tag tone="success">Ready</Tag>}
              >
                Workspace created and health check passed.
              </InfoBlock>
              <InfoBlock icon="Send" title="Admin invites sent">
                Invites sent to: {admins.join(' · ')}
                {itAdminEmail ? (
                  <>
                    <br />
                    IT Admin invite sent to <b>{itAdminEmail}</b>
                  </>
                ) : null}
                <br />
                <span style={{ color: 'var(--ink-3)' }}>
                  Each admin gets an email to create their Capiro credentials and sign in — they'll
                  land in the firm setup dashboard.
                </span>
              </InfoBlock>
              <InfoBlock
                icon="ReceiptText"
                title={session.plan === 'trial' ? 'Trial billing' : 'Payment'}
              >
                {receipt}
              </InfoBlock>
              <div
                style={{
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 6,
                  padding: '12px 14px',
                }}
              >
                <b
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--ink-3)',
                  }}
                >
                  What happens next
                </b>
                <ol
                  style={{
                    margin: '8px 0 0',
                    padding: '0 0 0 18px',
                    fontSize: 12,
                    color: 'var(--ink-2)',
                    lineHeight: 1.7,
                  }}
                >
                  <li>Admins create credentials and sign in to the setup dashboard</li>
                  <li>Firm-level setup: email authorization, client import, AI settings</li>
                  <li>The whole team is invited to log in to Capiro</li>
                </ol>
              </div>
            </div>
            {session.roleMode === 'self' ? (
              <Btn
                variant="primary"
                onClick={() => navigate('/setup')}
                style={{ width: '100%', marginTop: 20 }}
                icon="ArrowRight"
              >
                Go to your setup dashboard
              </Btn>
            ) : (
              <div
                style={{
                  marginTop: 20,
                  fontSize: 12.5,
                  color: 'var(--ink-2)',
                  textAlign: 'center',
                }}
              >
                You're all set — your admins take it from here.
              </div>
            )}
          </>
        )}
      </Card>
    </FunnelShell>
  );
}
