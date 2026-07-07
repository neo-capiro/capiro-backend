// 1.3 Email Verification — F1Verify (prototype/02-flow1.jsx), wired to Clerk's
// email_link sign-up verification (signUp.createEmailLinkFlow) + verify-check.
import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth, useSignUp } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn, Card, FunnelShell, Icon } from '../../ui/primitives';
import {
  FUNNEL_SESSION_KEY,
  readRegistrationDraft,
  useAdvanceSession,
  useFunnelApi,
  useFunnelSession,
} from '../../lib/funnel';
import { ErrorText, errorMessage } from './shared';

export function VerifyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const api = useFunnelApi();
  const advanceSession = useAdvanceSession();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: signUpLoaded, signUp, setActive } = useSignUp();
  const session = useFunnelSession();

  const [verified, setVerified] = React.useState(false);
  const [flowError, setFlowError] = React.useState<string | null>(null);

  const signUpInProgress = !!signUp?.emailAddress;
  const email = session.data?.email || signUp?.emailAddress || '';

  // ── Signed-out path: an in-progress Clerk sign-up awaits its email link.
  // startEmailLinkFlow sends the link and resolves once the user clicks it.
  const flowStartedRef = React.useRef(false);
  const registeredRef = React.useRef(false);
  const cancelFlowRef = React.useRef<(() => void) | null>(null);

  const finalizeSignUp = React.useCallback(
    async (attempt: {
      createdSessionId: string | null;
      firstName: string | null;
      lastName: string | null;
    }) => {
      if (!setActive) return;
      registeredRef.current = true; // we register right here — skip the fallback effect
      await setActive({ session: attempt.createdSessionId });
      const draft = readRegistrationDraft();
      const snapshot = await api.register({
        firstName: draft?.firstName ?? attempt.firstName ?? '',
        lastName: draft?.lastName ?? attempt.lastName ?? '',
        orgName: draft?.orgName ?? '',
      });
      queryClient.setQueryData(FUNNEL_SESSION_KEY, snapshot);
      const check = await api.verifyCheck();
      if (check.verified) {
        advanceSession({ state: 'verified' });
        setVerified(true);
      }
      // If not verified yet, the signed-in verify-check poll below takes over.
    },
    [setActive, api, queryClient, advanceSession],
  );

  const runEmailLinkFlow = React.useCallback(async () => {
    if (!signUp) return;
    setFlowError(null);
    try {
      // The tab the email link opens lands here with the sign-up already
      // complete — finish it directly instead of sending another link.
      if (signUp.status === 'complete') {
        await finalizeSignUp(signUp);
        return;
      }
      const { startEmailLinkFlow, cancelEmailLinkFlow } = signUp.createEmailLinkFlow();
      cancelFlowRef.current = cancelEmailLinkFlow;
      const attempt = await startEmailLinkFlow({
        redirectUrl: `${window.location.origin}/verify?complete=1`,
      });
      if (attempt.status === 'complete') {
        await finalizeSignUp(attempt);
      }
    } catch (err) {
      setFlowError(errorMessage(err));
    }
  }, [signUp, finalizeSignUp]);

  React.useEffect(() => {
    if (!signUpLoaded || !authLoaded) return;
    if (isSignedIn || !signUpInProgress) return;
    if (flowStartedRef.current) return;
    flowStartedRef.current = true;
    void runEmailLinkFlow();
  }, [signUpLoaded, authLoaded, isSignedIn, signUpInProgress, runEmailLinkFlow]);

  // ── Fallback: signed in but no funnel session yet (e.g. the sign-up was
  // completed elsewhere) — snapshot the registration so verify-check can run.
  React.useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    if (session.isLoading || session.data) return;
    if (registeredRef.current) return;
    registeredRef.current = true;
    void (async () => {
      try {
        const draft = readRegistrationDraft();
        const snapshot = await api.register({
          firstName: draft?.firstName ?? '',
          lastName: draft?.lastName ?? '',
          orgName: draft?.orgName ?? '',
        });
        queryClient.setQueryData(FUNNEL_SESSION_KEY, snapshot);
      } catch (err) {
        setFlowError(errorMessage(err));
      }
    })();
  }, [authLoaded, isSignedIn, session.isLoading, session.data, api, queryClient]);

  // ── Signed-in path (resumed session, or the tab the email link opened):
  // POST /funnel/verify-check, polling every 3s while unverified.
  const verifyCheck = useQuery({
    queryKey: ['funnel', 'verify-check'],
    queryFn: () => api.verifyCheck(),
    enabled: authLoaded && !!isSignedIn && !verified && !!session.data,
    retry: false,
    refetchInterval: (query) => (query.state.data?.verified ? false : 3000),
  });
  const checkVerified = verifyCheck.data?.verified === true;
  React.useEffect(() => {
    if (checkVerified && !verified) {
      advanceSession({ state: 'verified' });
      setVerified(true);
    }
  }, [checkVerified, verified, advanceSession]);

  const resend = () => {
    cancelFlowRef.current?.();
    void runEmailLinkFlow();
  };

  if (!authLoaded || !signUpLoaded) return null;
  // Nothing to verify: no sign-up in flight and no signed-in session.
  if (!isSignedIn && !signUpInProgress) return <Navigate to="/register" replace />;

  return (
    <FunnelShell step={1} maxWidth={460}>
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
          <Icon name="MailCheck" size={24} style={{ color: 'var(--accent)' }} />
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
          Check your inbox
        </h1>
        <p
          style={{ margin: '10px 0 22px', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}
        >
          We sent a verification link to <b style={{ color: 'var(--ink-1)' }}>{email}</b>.
          <br />
          You can't continue until your email is verified.
        </p>
        {!verified ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <Btn variant="primary" disabled>
              Continue
            </Btn>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--success)',
              }}
            >
              <Icon name="CircleCheck" size={15} />
              Email verified
            </div>
            <Btn variant="primary" onClick={() => navigate('/plan')}>
              Continue
            </Btn>
          </div>
        )}
        {flowError && <ErrorText>{flowError}</ErrorText>}
        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--ink-3)' }}>
          Didn't get it?{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              resend();
            }}
            style={{ color: 'var(--accent)' }}
          >
            Resend link
          </a>
        </div>
      </Card>
    </FunnelShell>
  );
}
