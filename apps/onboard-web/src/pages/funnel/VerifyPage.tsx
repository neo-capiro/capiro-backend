// 1.3 Email Verification — F1Verify (prototype/02-flow1.jsx), wired to Clerk's
// email_code sign-up verification (prepareEmailAddressVerification +
// attemptEmailAddressVerification). The Clerk instance issues one-time codes,
// not magic links (email_link is disabled), so we send a 6-digit code and
// verify it inline in the same tab — no redirect-URL round-trip.
import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth, useSignUp, useUser } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn, Card, FunnelShell, Icon, TextInput } from '../../ui/primitives';
import {
  draftMatchesUser,
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
  const { user } = useUser();
  const session = useFunnelSession();

  const [verified, setVerified] = React.useState(false);
  const [flowError, setFlowError] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // True from the moment a completed sign-up starts finalizing (setActive →
  // register → verify-check). CRITICAL: when the PIN is accepted, Clerk
  // consumes the sign-up resource (signUpInProgress flips false) BEFORE
  // setActive signs the user in — without this flag the render guard below
  // bounces to /register in that window, unmounting the page mid-finalize.
  const [finalizing, setFinalizing] = React.useState(false);

  const signUpInProgress = !!signUp?.emailAddress;
  const email = session.data?.email || signUp?.emailAddress || '';

  // ── Signed-out path: an in-progress Clerk sign-up awaits its email code. We
  // send the code once on mount, then verify whatever the user types below.
  const codeSentRef = React.useRef(false);
  const registeredRef = React.useRef(false);

  const finalizeSignUp = React.useCallback(
    async (attempt: {
      createdSessionId: string | null;
      firstName: string | null;
      lastName: string | null;
    }) => {
      if (!setActive) return;
      registeredRef.current = true; // we register right here — skip the fallback effect
      setFinalizing(true); // hold the render guard: keep this page mounted
      try {
        await setActive({ session: attempt.createdSessionId });
        const draft = readRegistrationDraft();
        // orgName exists only in the local draft (Clerk never stores it) and
        // RegisterDto rejects an empty one — re-collect instead of 400ing.
        if (!draft?.orgName?.trim()) {
          navigate('/register', { replace: true });
          return;
        }
        const registerBody = {
          firstName: draft.firstName || attempt.firstName || '',
          lastName: draft.lastName || attempt.lastName || '',
          orgName: draft.orgName,
        };
        let snapshot;
        try {
          snapshot = await api.register(registerBody);
        } catch {
          // The Clerk token can lag setActive by a beat — one retry covers it.
          await new Promise((resolve) => setTimeout(resolve, 1200));
          snapshot = await api.register(registerBody);
        }
        queryClient.setQueryData(FUNNEL_SESSION_KEY, snapshot);
        const check = await api.verifyCheck();
        if (check.verified) {
          advanceSession({ state: 'verified' });
          setVerified(true);
        }
        // If not verified yet, the signed-in verify-check poll below takes over.
      } catch (err) {
        // Recoverable: the signed-in fallback effect (or a manual retry) can
        // finish registration — release both latches before surfacing.
        registeredRef.current = false;
        setFinalizing(false);
        throw err;
      }
    },
    [setActive, api, queryClient, advanceSession, navigate],
  );

  // Send (or re-send) the 6-digit verification code.
  const sendCode = React.useCallback(async () => {
    if (!signUp) return;
    setFlowError(null);
    try {
      // The tab may already have a complete sign-up (resumed) — finish it
      // directly instead of sending another code.
      if (signUp.status === 'complete') {
        await finalizeSignUp(signUp);
        return;
      }
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    } catch (err) {
      setFlowError(errorMessage(err));
    }
  }, [signUp, finalizeSignUp]);

  React.useEffect(() => {
    if (!signUpLoaded || !authLoaded) return;
    if (isSignedIn || !signUpInProgress) return;
    if (codeSentRef.current) return;
    codeSentRef.current = true;
    void sendCode();
  }, [signUpLoaded, authLoaded, isSignedIn, signUpInProgress, sendCode]);

  const submitCode = React.useCallback(async () => {
    if (!signUp || submitting) return;
    const trimmed = code.trim();
    if (trimmed.length < 6) return;
    setSubmitting(true);
    setFlowError(null);
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code: trimmed });
      if (attempt.status === 'complete') {
        await finalizeSignUp(attempt);
      } else {
        setFlowError('That code didn’t complete verification — request a new one and try again.');
      }
    } catch (err) {
      setFlowError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [signUp, submitting, code, finalizeSignUp]);

  // ── Fallback: signed in but no funnel session yet (e.g. the sign-up was
  // completed elsewhere) — snapshot the registration so verify-check can run.
  // Without a stored draft (orgName is never in Clerk) an empty register POST
  // would 400 into a dead-end, so send the user back to /register instead.
  React.useEffect(() => {
    if (!authLoaded || !isSignedIn || finalizing) return;
    if (session.isLoading || session.data) return;
    if (registeredRef.current) return;
    registeredRef.current = true;
    void (async () => {
      const draft = readRegistrationDraft();
      // No usable draft, OR a draft typed by a DIFFERENT person than this
      // session (shared browser) — never register the wrong account as the
      // purchaser; /register shows the identity banner and re-collects.
      if (
        !draft?.orgName?.trim() ||
        !draftMatchesUser(draft, user?.primaryEmailAddress?.emailAddress)
      ) {
        navigate('/register', { replace: true });
        return;
      }
      try {
        const snapshot = await api.register({
          firstName: draft.firstName ?? '',
          lastName: draft.lastName ?? '',
          orgName: draft.orgName,
        });
        queryClient.setQueryData(FUNNEL_SESSION_KEY, snapshot);
      } catch (err) {
        setFlowError(errorMessage(err));
      }
    })();
  }, [
    authLoaded,
    isSignedIn,
    finalizing,
    session.isLoading,
    session.data,
    api,
    queryClient,
    navigate,
    user,
  ]);

  // ── Signed-in path (resumed session): POST /funnel/verify-check, polling
  // every 3s while unverified as a safety net for out-of-band verification.
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
    setCode('');
    void sendCode();
  };

  if (!authLoaded || !signUpLoaded) return null;
  // Nothing to verify: no sign-up in flight and no signed-in session — but
  // NEVER bounce while a completed sign-up is finalizing: in that window the
  // sign-up resource is already consumed and isSignedIn hasn't flipped yet,
  // so this guard used to fire and dump the user back on /register.
  if (!isSignedIn && !signUpInProgress && !finalizing) {
    return <Navigate to="/register" replace />;
  }

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
          We sent a 6-digit code to <b style={{ color: 'var(--ink-1)' }}>{email}</b>.
          <br />
          Enter it below to verify your email — you can’t continue until it’s verified.
        </p>
        {!verified ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <TextInput
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCode();
              }}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Verification code"
              style={{ textAlign: 'center', letterSpacing: '0.4em', fontSize: 18, fontWeight: 600 }}
            />
            <Btn
              variant="primary"
              disabled={code.trim().length < 6 || submitting}
              onClick={() => void submitCode()}
            >
              {submitting ? 'Verifying…' : 'Verify email'}
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
            Resend code
          </a>
        </div>
      </Card>
    </FunnelShell>
  );
}
