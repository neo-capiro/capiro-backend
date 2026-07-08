// 2A — Dashboard Home (all inline task states) — for Admin / Super Admin.
// Port of prototype Ext2ADashboard, driven by GET /onboard-api/setup/state.
import React from 'react';
import { useAuth, useOrganizationList, useUser } from '@clerk/clerk-react';
import { Btn, Card, Icon, Spinner, TextInput } from '../../ui/primitives';
import { useConfig } from '../../useConfig';
import { ErrorText, errorMessage } from '../funnel/shared';
import {
  ApiError,
  useSetupApi,
  useSetupState,
  type SetupState,
  type SetupTaskKey,
} from '../../lib/setup';
import { useMe } from '../../lib/capiro-api';
import { ExtShell, TaskCard } from './ExtShell';
import { ImportOverlay } from './ImportOverlay';
import { AiSettingsOverlay } from './AiSettingsOverlay';
import { InvitesOverlay } from './InvitesOverlay';

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 480, margin: '40px auto 0' }}>
      <Card style={{ textAlign: 'center', padding: '40px 36px' }}>{children}</Card>
    </div>
  );
}

export function SetupDashboardPage() {
  const config = useConfig();
  const setupApi = useSetupApi();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const { user } = useUser();

  // Invite-accepted sessions can land without an active Clerk org — both APIs
  // resolve the tenant from org claims, so activate the (only) membership.
  const orgList = useOrganizationList({ userMemberships: { pageSize: 10 } });
  React.useEffect(() => {
    if (!isSignedIn || orgId || !orgList.isLoaded) return;
    const first = orgList.userMemberships?.data?.[0];
    if (first && orgList.setActive) {
      void orgList.setActive({ organization: first.organization.id });
    }
  }, [isSignedIn, orgId, orgList.isLoaded, orgList.userMemberships?.data, orgList.setActive]);

  const state = useSetupState({ enabled: !!orgId });
  const me = useMe({ enabled: !!orgId });

  const [overlay, setOverlay] = React.useState<null | 'import' | 'ai' | 'invites'>(null);
  const [newIt, setNewIt] = React.useState('');
  const [addingAnother, setAddingAnother] = React.useState(false);
  const [sendingInvite, setSendingInvite] = React.useState(false);
  const [resending, setResending] = React.useState(false);
  const [itError, setItError] = React.useState<string | null>(null);

  if (!isLoaded) return null;

  if (!isSignedIn) {
    return (
      <ExtShell>
        <CenteredNotice>
          <p style={{ margin: '0 0 20px', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Sign in via your invite email to access the setup dashboard.
          </p>
          <Btn
            variant="primary"
            onClick={() => window.location.assign(`${config.appBaseUrl}/sign-in`)}
          >
            Sign in
          </Btn>
        </CenteredNotice>
      </ExtShell>
    );
  }

  if (!orgId) {
    if (orgList.isLoaded && (orgList.userMemberships?.data?.length ?? 0) === 0) {
      return (
        <ExtShell>
          <CenteredNotice>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              No firm workspace is linked to your account yet — use the invite link from your email,
              or contact support@capiro.ai.
            </p>
          </CenteredNotice>
        </ExtShell>
      );
    }
    return (
      <ExtShell>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <Spinner size={18} />
        </div>
      </ExtShell>
    );
  }

  if (state.isLoading) {
    return (
      <ExtShell>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <Spinner size={18} />
        </div>
      </ExtShell>
    );
  }
  if (state.error || !state.data) {
    return (
      <ExtShell>
        <CenteredNotice>
          <p style={{ margin: '0 0 20px', fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            {state.error ? errorMessage(state.error) : 'Could not load your setup state.'}
          </p>
          <Btn variant="primary" onClick={() => void state.refetch()}>
            Retry
          </Btn>
        </CenteredNotice>
      </ExtShell>
    );
  }

  const S: SetupState = state.data;
  const tasks = S.tasks;
  const refetch = () => state.refetch();

  const emailDone = tasks.it_email === 'done';
  const importDone = tasks.import === 'done';
  const aiDone = tasks.firm_ai === 'done';
  const doneCount = [emailDone, importDone, aiDone, tasks.invites === 'done'].filter(
    Boolean,
  ).length;
  // Firm AI settings are OPTIONAL — only email + import gate the team invites
  // (mirrors the server-side blockers in setup.service.completeSetup).
  const invitesUnlocked = emailDone && importDone;

  const cap = S.cap;
  const atCap = S.imported >= cap;

  const latestSentInvite =
    [...S.itInvites].reverse().find((i) => i.status === 'sent') ??
    S.itInvites[S.itInvites.length - 1];

  const sendItInvite = async () => {
    if (!newIt.includes('@') || sendingInvite) return;
    setSendingInvite(true);
    setItError(null);
    try {
      await setupApi.createItInvite(newIt.trim());
      setNewIt('');
      setAddingAnother(false);
      await refetch();
    } catch (err) {
      setItError(errorMessage(err));
    } finally {
      setSendingInvite(false);
    }
  };

  const resendItInvite = async () => {
    if (!latestSentInvite || resending) return;
    setResending(true);
    setItError(null);
    try {
      await setupApi.resendItInvite(latestSentInvite.id);
    } catch (err) {
      setItError(errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  /** UI-initiated task completion: CAS to 'done'; a 409 just means someone else won. */
  const transitionToDone = async (task: SetupTaskKey) => {
    const from = tasks[task];
    if (from === 'done') return;
    try {
      await setupApi.transitionTask(task, from, 'done');
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) {
        console.error(`Task ${task} transition failed`, err);
      }
    }
    await refetch();
  };

  const itInviteInput = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <TextInput
          placeholder="it-admin@yourfirm.com"
          value={newIt}
          onChange={(e) => setNewIt(e.target.value)}
          style={{ maxWidth: 300 }}
        />
        <Btn
          variant="primary"
          size="sm"
          disabled={!newIt.includes('@') || sendingInvite}
          onClick={() => void sendItInvite()}
          style={{ alignSelf: 'center' }}
        >
          {sendingInvite ? 'Sending…' : 'Send Invite'}
        </Btn>
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
        IT Admin will receive an email with instructions. You can add multiple contacts.
      </span>
      {itError && <ErrorText style={{ marginTop: 0 }}>{itError}</ErrorText>}
    </div>
  );

  return (
    <ExtShell orgName={S.orgName}>
      <div
        style={{
          marginBottom: 8,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-serif)',
              fontWeight: 500,
              fontSize: 28,
              letterSpacing: '-0.015em',
            }}
          >
            {user?.firstName ? `Welcome, ${user.firstName}.` : 'Welcome.'}
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--ink-2)' }}>
            Complete the steps below to launch your Capiro workspace.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--ink-2)',
              fontFamily: 'var(--font-mono)',
              letterSpacing: 0,
            }}
          >
            {doneCount} of 4 steps complete
          </div>
          <div
            style={{
              width: 170,
              height: 5,
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border-1)',
              borderRadius: 99,
              marginTop: 6,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${(doneCount / 4) * 100}%`,
                height: '100%',
                background: 'var(--accent)',
                borderRadius: 99,
                transition: 'width 0.4s ease',
              }}
            ></div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, marginTop: 20 }}>
        {/* Task 1 — Connect email provider */}
        <TaskCard
          num="1"
          title="Connect email provider"
          status={tasks.it_email}
          desc="Your IT administrator must authenticate to grant org-wide access."
          action={
            tasks.it_email === 'done' ? null : tasks.it_email === 'waiting' ? (
              <Btn
                size="sm"
                disabled={resending}
                onClick={() => void resendItInvite()}
                icon="RefreshCw"
              >
                Resend
              </Btn>
            ) : null
          }
        >
          {tasks.it_email === 'done' ? (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                fontSize: 12.5,
                color: 'var(--success)',
                fontWeight: 600,
              }}
            >
              <Icon name="CircleCheck" size={15} />
              Email access granted — all users can now connect individually.
            </div>
          ) : tasks.it_email === 'verifying' ? (
            <div
              style={{
                display: 'flex',
                gap: 9,
                alignItems: 'center',
                fontSize: 12.5,
                color: 'var(--ink-2)',
              }}
            >
              <Spinner />
              Verifying connection…
            </div>
          ) : tasks.it_email === 'waiting' && !addingAnother ? (
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--ink-2)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <span>
                Invite sent to <b>{latestSentInvite?.email}</b> ·{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void resendItInvite();
                  }}
                  style={{ color: 'var(--accent)' }}
                >
                  Resend
                </a>{' '}
                ·{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setAddingAnother(true);
                  }}
                  style={{ color: 'var(--accent)' }}
                >
                  Add another contact
                </a>
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                IT Admin will receive an email with instructions.
              </span>
              {itError && <ErrorText style={{ marginTop: 0 }}>{itError}</ErrorText>}
            </div>
          ) : (
            itInviteInput
          )}
        </TaskCard>

        {/* Task 2 — Import client profiles */}
        <TaskCard
          num="2"
          title="Import client profiles"
          status={tasks.import}
          desc={`Add your client portfolio. Limit: ${cap} profiles (${S.plan === 'paid' ? 'paid' : 'trial'}).`}
          action={
            <Btn
              variant={tasks.import === 'none' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setOverlay('import')}
            >
              {tasks.import === 'none'
                ? 'Start Import'
                : tasks.import === 'done'
                  ? 'Import more'
                  : 'Continue Import'}
            </Btn>
          }
        >
          {tasks.import !== 'none' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  flex: 1,
                  height: 5,
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 99,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, (S.imported / cap) * 100)}%`,
                    height: '100%',
                    background: atCap ? 'var(--notable)' : 'var(--accent)',
                    borderRadius: 99,
                    transition: 'width 0.3s ease',
                  }}
                ></div>
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: 0,
                  color: 'var(--ink-2)',
                }}
              >
                {S.imported} of {cap} profiles imported
              </span>
            </div>
          )}
        </TaskCard>

        {/* Task 3 — Firm AI settings (OPTIONAL — does not gate invites) */}
        <TaskCard
          num="3"
          title="Configure firm AI settings"
          status={tasks.firm_ai}
          desc="Optional — set guardrails, tone, and preferences for your whole team. You can also do this later from Settings."
          action={
            tasks.firm_ai === 'done' ? (
              <Btn size="sm" onClick={() => setOverlay('ai')}>
                Edit
              </Btn>
            ) : (
              <Btn variant="primary" size="sm" onClick={() => setOverlay('ai')}>
                Configure
              </Btn>
            )
          }
        />

        {/* Task 4 — Invite team (gated) */}
        <TaskCard
          num="4"
          title="Invite your team"
          locked={!invitesUnlocked}
          status={tasks.invites === 'done' ? 'done' : invitesUnlocked ? 'none' : 'locked'}
          desc={
            invitesUnlocked
              ? 'Your workspace is ready for the rest of the firm.'
              : 'Available once the email provider is connected and clients are imported.'
          }
          action={
            invitesUnlocked && tasks.invites !== 'done' ? (
              <Btn variant="primary" size="sm" onClick={() => setOverlay('invites')}>
                Send Invites
              </Btn>
            ) : tasks.invites === 'done' ? (
              <Btn
                variant="primary"
                size="sm"
                onClick={() => window.location.assign(config.appBaseUrl)}
                icon="ArrowRight"
              >
                Continue to Capiro
              </Btn>
            ) : null
          }
        />
      </div>

      {overlay === 'import' && (
        <ImportOverlay
          cap={cap}
          imported={S.imported}
          plan={S.plan}
          billingAdmin={me.data?.billingAdmin ?? false}
          appBaseUrl={config.appBaseUrl}
          onClose={() => setOverlay(null)}
          onImported={(created) => {
            if (created > 0) void transitionToDone('import');
          }}
        />
      )}
      {overlay === 'ai' && (
        <AiSettingsOverlay
          orgName={S.orgName}
          onClose={() => setOverlay(null)}
          onComplete={() => {
            setOverlay(null);
            void transitionToDone('firm_ai');
          }}
        />
      )}
      {overlay === 'invites' && (
        <InvitesOverlay
          orgName={S.orgName}
          appBaseUrl={config.appBaseUrl}
          onClose={() => setOverlay(null)}
          onCompleted={() => void refetch()}
        />
      )}
    </ExtShell>
  );
}
