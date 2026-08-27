import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Loader2,
  Mail,
  Paperclip,
  PauseCircle,
  RefreshCcw,
  Send,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import {
  type OutreachAttachment,
  type OutreachV3DraftArtifact,
  type OutreachV3GenerationPlan,
  type OutreachV3NamedPreflightCheck,
  type OutreachV3PreflightInput,
  type OutreachV3SendSettings,
  type OutreachV3ServerPreflight,
} from './engagement-api.js';
import { approvalCount } from './outreach-v3-phase1-model.js';
import {
  EmptyState,
  type IntegrationConnection,
  StatusChip,
  buttonLabelForCheck,
  deliveryLabel,
  formatClock,
  providerLabel,
  recipientPresentation,
} from './outreach-v3-phase1-shared.js';

export function SendSetupCard({
  rows,
  onChange,
}: {
  rows: Array<{ key: string; value: string; target?: 'drafts' | 'mailbox' | 'timing' }>;
  onChange: (target?: 'drafts' | 'mailbox' | 'timing') => void;
}) {
  return (
    <section className="ov3p1-card ov3p1-send-setup">
      <h3>What will happen</h3>
      <dl>
        {rows.map((row) => (
          <div key={row.key}>
            <dt>{row.key}</dt>
            <dd>{row.value}</dd>
            {row.target ? (
              <button type="button" onClick={() => onChange(row.target)}>Change</button>
            ) : <span />}
          </div>
        ))}
      </dl>
    </section>
  );
}

export function PreflightCheckCard({
  check,
  onFix,
}: {
  check: OutreachV3NamedPreflightCheck;
  onFix: () => void;
}) {
  const blocked = check.state === 'blocked';
  const review = check.state === 'review';
  return (
    <article className="ov3p1-check-card" data-state={check.state}>
      <span>{blocked ? <CircleAlert size={17} /> : review ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}</span>
      <div>
        <strong>{check.label}</strong>
        <p>{check.detail}</p>
      </div>
      {blocked || review ? <button type="button" onClick={onFix}>{buttonLabelForCheck(check)}</button> : null}
    </article>
  );
}

export function SendScreen({
  sessionId,
  sessionClientId,
  plan,
  drafts,
  integrations,
  settings,
  attachments,
  preflight,
  preflightAt,
  settingsBusy,
  settingsSaved,
  preflightBusy,
  testBusy,
  testSucceeded,
  sendBusy,
  error,
  onSaveSettings,
  onUpload,
  onRunPreflight,
  onTestSend,
  onOpenConfirm,
  onGoDrafts,
}: {
  sessionId: string;
  sessionClientId: string | null;
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  integrations: IntegrationConnection[];
  settings: OutreachV3SendSettings | null;
  attachments: OutreachAttachment[];
  preflight: OutreachV3ServerPreflight | null;
  preflightAt: Date | null;
  settingsBusy: boolean;
  settingsSaved: boolean;
  preflightBusy: boolean;
  testBusy: boolean;
  testSucceeded: boolean;
  sendBusy: boolean;
  error: string | null;
  onSaveSettings: (input: { senderConnectionId: string; appendSignature: boolean; attachmentIds: string[] }) => void;
  onUpload: (file: File) => void;
  onRunPreflight: (input: OutreachV3PreflightInput) => void;
  onTestSend: (generationKey: string, input: OutreachV3PreflightInput) => void;
  onOpenConfirm: (input: OutreachV3PreflightInput) => void;
  onGoDrafts: () => void;
}) {
  const connected = integrations.filter((connection) =>
    connection.status === 'connected' && ['microsoft_365', 'google_workspace'].includes(connection.provider),
  );
  const [senderConnectionId, setSenderConnectionId] = useState(settings?.senderConnectionId ?? connected[0]?.id ?? '');
  const [appendSignature, setAppendSignature] = useState(settings?.appendSignature ?? true);
  const [attachmentIds, setAttachmentIds] = useState<string[]>(settings?.attachmentIds ?? []);
  const [timing, setTiming] = useState<'now' | 'schedule'>('now');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York');
  const [pacing, setPacing] = useState<'steady' | 'quick'>('steady');
  const [partialMode, setPartialMode] = useState<'ready' | 'all'>('ready');
  const [acknowledge, setAcknowledge] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [testGenerationKey, setTestGenerationKey] = useState(drafts[0]?.generationKey ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settings) return;
    setSenderConnectionId(settings.senderConnectionId);
    setAppendSignature(settings.appendSignature);
    setAttachmentIds(settings.attachmentIds);
  }, [settings]);

  useEffect(() => {
    if (!senderConnectionId && connected[0]) setSenderConnectionId(connected[0].id);
  }, [connected, senderConnectionId]);

  const blockedResults = preflight?.draftResults.filter((result) => !result.eligible) ?? [];
  const blockedKeys = blockedResults.map((result) => result.generationKey).sort();
  const effectiveExcludedKeys = partialMode === 'ready' ? blockedKeys : [];
  const needsAcknowledgement = effectiveExcludedKeys.length > 0;
  const input: OutreachV3PreflightInput = {
    excludedGenerationKeys: effectiveExcludedKeys,
    acknowledgeHeldOut: !needsAcknowledgement || acknowledge,
  };
  const exclusionsCurrent =
    preflight &&
    [...preflight.excludedGenerationKeys].sort().join('|') === effectiveExcludedKeys.join('|') &&
    (!needsAcknowledgement || preflight.heldOutAcknowledged === acknowledge);
  const canSend = Boolean(
    timing === 'now' &&
    settings &&
    preflight?.eligible &&
    exclusionsCurrent &&
    (!needsAcknowledgement || acknowledge),
  );
  const selectedConnection = connected.find((connection) => connection.id === senderConnectionId) ?? null;
  const approved = approvalCount(drafts);
  const sendCount = preflight?.draftVersionIds.length ?? approved;

  const setupRows = [
    { key: 'How many', value: `${sendCount} email${sendCount === 1 ? '' : 's'}, one person each`, target: 'drafts' as const },
    { key: 'From', value: providerLabel(selectedConnection), target: 'mailbox' as const },
    { key: 'When', value: timing === 'now' ? `Straight away, ${pacing === 'steady' ? 'spread steadily' : 'as quickly as provider policy allows'}` : `${scheduleDate || 'Choose a date'} at ${scheduleTime} · ${timezone}`, target: 'timing' as const },
    { key: 'Delivery', value: deliveryLabel(plan?.deliveryPattern) },
    { key: 'Signature', value: appendSignature ? 'Append your current Capiro signature' : 'No signature' },
    { key: 'Attachments', value: attachmentIds.length ? `${attachmentIds.length} attached file${attachmentIds.length === 1 ? '' : 's'}` : 'No attachments' },
  ];
  const visibleChecks = showAll ? preflight?.checks ?? [] : (preflight?.checks ?? []).filter((check) => check.state !== 'pass').slice(0, 3);

  return (
    <div className="ov3p1-content ov3p1-content--narrow" id={`send-${sessionId}`} data-client={sessionClientId || undefined}>
      <h2>Before this goes out</h2>
      <p className="ov3p1-lead">Read exactly what will happen, choose what to do with blocked recipients, and run fresh checks before Capiro creates one durable send record.</p>

      <SendSetupCard
        rows={setupRows}
        onChange={(target) => {
          if (target === 'drafts') onGoDrafts();
          else document.getElementById(target === 'mailbox' ? 'ov3p1-mailbox' : 'ov3p1-timing')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
      />

      <section className="ov3p1-card ov3p1-mailbox-card" id="ov3p1-mailbox">
        <h3>Sending identity</h3>
        <label>
          <span>From</span>
          <select value={senderConnectionId} onChange={(event) => setSenderConnectionId(event.target.value)}>
            <option value="">Select a connected mailbox</option>
            {connected.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {providerLabel(connection)}{connection.accountEmail ? ` · ${connection.accountEmail}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="ov3p1-switch-row">
          <span>
            <strong>Signature</strong>
            <small>{appendSignature ? 'Append your current Capiro signature' : 'Do not append a signature'}</small>
          </span>
          <button type="button" role="switch" aria-checked={appendSignature} data-on={appendSignature || undefined} onClick={() => setAppendSignature((value) => !value)}><i /></button>
        </label>
        <div className="ov3p1-attachment-row">
          <span>
            <strong>Attachments</strong>
            <small>Changing attachments can invalidate exact-version approval.</small>
          </span>
          <div>
            {attachmentIds.map((id) => {
              const attachment = attachments.find((item) => item.id === id);
              return (
                <span className="ov3p1-attachment-chip" key={id}>
                  <Paperclip size={13} /> {attachment?.fileName ?? `File ${id.slice(0, 7)}`}
                  <button type="button" onClick={() => setAttachmentIds((current) => current.filter((value) => value !== id))}><X size={12} /></button>
                </span>
              );
            })}
          </div>
          <input ref={fileRef} hidden type="file" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.currentTarget.value = '';
          }} />
          <button type="button" className="ov3p1-button is-secondary" onClick={() => fileRef.current?.click()}><Upload size={14} /> Add attachment</button>
        </div>
        <button
          type="button"
          className="ov3p1-button is-primary"
          disabled={!senderConnectionId || settingsBusy}
          onClick={() => onSaveSettings({ senderConnectionId, appendSignature, attachmentIds })}
        >
          {settingsBusy ? <Loader2 className="ov3p1-spin" size={14} /> : <Check size={14} />}
          Save sending identity
        </button>
        {settingsSaved ? <StatusChip tone="navy">Identity saved</StatusChip> : null}
      </section>

      <section className="ov3p1-card ov3p1-timing-card" id="ov3p1-timing">
        <h3>When should it go?</h3>
        <div className="ov3p1-choice-row">
          <button type="button" data-selected={timing === 'now' || undefined} onClick={() => setTiming('now')}><Send size={16} /><span><strong>Send now</strong><small>Start after final confirmation.</small></span></button>
          <button type="button" data-selected={timing === 'schedule' || undefined} onClick={() => setTiming('schedule')}><Clock3 size={16} /><span><strong>Schedule</strong><small>Choose a date and time.</small></span></button>
        </div>
        {timing === 'schedule' ? (
          <div className="ov3p1-schedule-fields">
            <label>Date<input type="date" value={scheduleDate} onChange={(event) => setScheduleDate(event.target.value)} /></label>
            <label>Time<input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} /></label>
            <label>Timezone<select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option>America/New_York</option><option>America/Chicago</option><option>America/Denver</option><option>America/Los_Angeles</option><option>{timezone}</option></select></label>
            <p>Scheduling is presented in this Phase 1 UI, but the current server contract creates immediate send intents only. Keep “Send now” selected to send safely.</p>
          </div>
        ) : null}
        <span className="ov3p1-section-label">Pacing</span>
        <div className="ov3p1-choice-row">
          <button type="button" data-selected={pacing === 'steady' || undefined} onClick={() => setPacing('steady')}><span><strong>Steady</strong><small>Spread the send and stay inside mailbox limits.</small></span></button>
          <button type="button" data-selected={pacing === 'quick' || undefined} onClick={() => setPacing('quick')}><span><strong>Quick</strong><small>Provider policy remains authoritative.</small></span></button>
        </div>
        <span className="ov3p1-section-label">If some recipients are not ready</span>
        <label className="ov3p1-radio-card" data-selected={partialMode === 'ready' || undefined}>
          <input type="radio" checked={partialMode === 'ready'} onChange={() => { setPartialMode('ready'); setAcknowledge(false); }} />
          <span><strong>Send the ready recipients</strong><small>Hold blocked recipients out. They receive nothing.</small></span>
        </label>
        <label className="ov3p1-radio-card" data-selected={partialMode === 'all' || undefined}>
          <input type="radio" checked={partialMode === 'all'} onChange={() => { setPartialMode('all'); setAcknowledge(false); }} />
          <span><strong>Wait and send everyone together</strong><small>Any blocked recipient keeps the whole campaign from sending.</small></span>
        </label>
      </section>

      <section className="ov3p1-card ov3p1-test-card">
        <div>
          <Mail size={19} />
          <span><strong>Send one to yourself first</strong><small>The selected exact version goes only to your own connected mailbox.</small></span>
        </div>
        <select value={testGenerationKey} onChange={(event) => setTestGenerationKey(event.target.value)}>
          {drafts.map((draft) => <option value={draft.generationKey} key={draft.id}>{recipientPresentation(draft, plan).label} · V{draft.current?.version ?? draft.currentVersion}</option>)}
        </select>
        <button
          type="button"
          className="ov3p1-button is-secondary"
          disabled={!testGenerationKey || testBusy || !settings}
          onClick={() => onTestSend(testGenerationKey, input)}
        >
          {testBusy ? <Loader2 className="ov3p1-spin" size={14} /> : <Send size={14} />}
          {testSucceeded ? 'Send another test' : 'Send a test to me'}
        </button>
        {testSucceeded ? <StatusChip tone="navy">Test send created</StatusChip> : null}
        {!settings ? (
          <p className="ov3p1-inline-hint">
            Save a sending identity above first — this button turns on once you pick a mailbox and click{' '}
            <strong>Save sending identity</strong>.
          </p>
        ) : null}
      </section>

      <section className="ov3p1-preflight">
        <header>
          <div>
            <span>Preflight</span>
            <h3>Fourteen checks, using fresh server reads</h3>
            <p>{preflightAt ? `Last checked ${formatClock(preflightAt)}` : 'Not checked for the current versions.'}</p>
            {!settings ? <p className="ov3p1-inline-hint">Save a sending identity above first.</p> : null}
          </div>
          <button type="button" className="ov3p1-button is-secondary" disabled={preflightBusy || !settings} onClick={() => onRunPreflight(input)}>
            {preflightBusy ? <Loader2 className="ov3p1-spin" size={14} /> : <RefreshCcw size={14} />}
            {preflight ? 'Run them again' : 'Run the checks'}
          </button>
        </header>

        {!preflight ? (
          <EmptyState icon={<ShieldCheck size={23} />} title="Checks have not run" body="Save the sending identity, then run preflight against the current exact versions." />
        ) : (
          <>
            <div className="ov3p1-check-stack">
              {(visibleChecks.length ? visibleChecks : preflight.checks.slice(0, 3)).map((check) => (
                <PreflightCheckCard key={check.key} check={check} onFix={onGoDrafts} />
              ))}
            </div>
            <button type="button" className="ov3p1-show-all" onClick={() => setShowAll((value) => !value)}>
              {showAll ? 'Show only what needs attention' : `Show all ${preflight.checks.length || 14} checks`}
              <ChevronDown size={14} />
            </button>
          </>
        )}
      </section>

      {blockedResults.length ? (
        <section className="ov3p1-held-summary">
          <div>
            <PauseCircle size={18} />
            <span><strong>{blockedResults.length} recipient{blockedResults.length === 1 ? '' : 's'} are not ready</strong><small>{partialMode === 'ready' ? 'They will be held out when preflight is rerun with this choice.' : 'The campaign will remain blocked until they are ready.'}</small></span>
          </div>
          {blockedResults.map((result) => {
            const draft = drafts.find((item) => item.generationKey === result.generationKey);
            return <p key={result.generationKey}><strong>{draft ? recipientPresentation(draft, plan).label : result.generationKey}</strong> · {result.blockers.map((value) => value.toLowerCase().replaceAll('_', ' ')).join(' · ')}</p>;
          })}
          {partialMode === 'ready' ? (
            <label className="ov3p1-consent">
              <input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} />
              <span><strong>I understand those recipients will not be contacted</strong><small>This does not resolve their blockers or send to them.</small></span>
            </label>
          ) : null}
          {!exclusionsCurrent ? <p className="ov3p1-note">Your partial-send choice changed — run preflight again before sending.</p> : null}
        </section>
      ) : null}

      {timing === 'schedule' ? <p className="ov3p1-note is-warning">Scheduled delivery needs a server scheduling contract. This release intentionally refuses to disguise an immediate send as a scheduled one.</p> : null}
      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}

      <div className="ov3p1-send-footer">
        <button type="button" className="ov3p1-button is-primary is-send" disabled={!canSend || sendBusy} onClick={() => onOpenConfirm(input)}>
          <Send size={16} />
          {sendBusy ? 'Creating one send record…' : `Send ${sendCount} email${sendCount === 1 ? '' : 's'}`}
        </button>
        <span>
          {!settings
            ? 'Save the sending identity first.'
            : !preflight
              ? 'Run preflight first.'
              : !preflight.eligible
                ? 'Resolve the blocking checks or hold eligible recipients out.'
                : needsAcknowledgement && !acknowledge
                  ? 'Acknowledge the held-out recipients.'
                  : 'The confirmation dialog is the only real-send trigger.'}
        </span>
      </div>
    </div>
  );
}
