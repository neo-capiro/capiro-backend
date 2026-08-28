import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckSquare, CircleAlert, Loader2, RefreshCcw } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import {
  type OutreachAttachment,
  type OutreachV3CheckState,
  type OutreachV3DraftArtifact,
  type OutreachV3GenerationPlan,
  type OutreachV3NamedPreflightCheck,
  type OutreachV3PreflightInput,
  type OutreachV3ServerPreflight,
  createOutreachV3SendIntent,
  createOutreachV3TestSend,
  getOutreachV3GenerationPlan,
  getOutreachV3SendSettings,
  listOutreachAttachments,
  listOutreachV3Drafts,
  runOutreachV3Preflight,
} from './engagement-api.js';
import { getOutreachTemplateProvenance } from './outreach-v3-template-api.js';
import { outreachReadyRecipientCount, outreachSendGate } from './outreach-campaign-flow.js';
import {
  type OutreachBuilderStepCommon,
  outreachBlockedTargets,
  outreachEffectiveEmailFormat,
  outreachSelectedTargets,
  outreachSponsorFromSpec,
} from './outreach-builder-model.js';
import { formatClock, randomKey, recipientPresentation } from './outreach-v3-phase1-shared.js';
import './outreach-step-send.css';

/* ------------------------------------------------------------------ *
 * Copy the prototype fixes
 * ------------------------------------------------------------------ */

const SCHEDULE_CAVEAT =
  'Scheduling is shown here, but the server contract creates immediate send intents only. Keep “Send now” selected to send safely.';

/**
 * Rendered only when passing checks were hidden, so the sentence stays true.
 * The prototype prints it unconditionally beneath three hard-coded rows.
 */
const PREFLIGHT_FOOTNOTE = 'Showing what needs attention. The remaining checks passed.';

const TIMING_OPTIONS: Array<{ id: SendTiming; label: string; desc: string }> = [
  { id: 'now', label: 'Send now', desc: 'Start after final confirmation.' },
  { id: 'schedule', label: 'Schedule', desc: 'Choose a date and time.' },
];

const PACING_OPTIONS: Array<{ id: SendPacing; label: string; desc: string }> = [
  { id: 'steady', label: 'Steady', desc: 'Spread the send and stay inside mailbox limits.' },
  { id: 'quick', label: 'Quick', desc: 'Provider policy remains authoritative.' },
];

const PARTIAL_OPTIONS: Array<{ id: PartialChoice; label: string; desc: string }> = [
  {
    id: 'ready',
    label: 'Send the ready recipients',
    desc: 'Hold blocked recipients out. They receive nothing.',
  },
  {
    id: 'all',
    label: 'Wait and send everyone together',
    desc: 'Any blocked recipient keeps the whole campaign from sending.',
  },
];

type SendTiming = 'now' | 'schedule';
type SendPacing = 'steady' | 'quick';
type PartialChoice = 'ready' | 'all';

/* ------------------------------------------------------------------ *
 * Small pure helpers (exported for the test, and because the counting
 * rules are the part most likely to drift)
 * ------------------------------------------------------------------ */

/**
 * The prototype's "How many" row. Its singular/plural ternary on the held-out
 * suffix is degenerate — both branches read " held out" — so the suffix is
 * fixed here too rather than "corrected"; only the counts are real.
 */
export function outreachSendHowManyRow(input: {
  selectedCount: number;
  blockedCount: number;
  readyCount: number;
  holdsAll: boolean;
}): string {
  if (input.blockedCount > 0 && !input.holdsAll) {
    return `${input.readyCount} of ${input.selectedCount} emails, one person each · ${input.blockedCount} held out`;
  }
  return input.selectedCount === 1
    ? '1 email, one person'
    : `${input.selectedCount} emails, one person each`;
}

const COUNT_WORDS = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];

/**
 * The prototype hard-codes "Fourteen checks" while rendering three rows. The
 * server returns between 3 and 19 real checks, so the count is spelled from
 * what actually came back and the heading only says fourteen when it is.
 */
export function outreachPreflightHeading(checkCount: number | null): string {
  if (checkCount === null) return 'Checks, using fresh server reads';
  const word = COUNT_WORDS[checkCount] ?? String(checkCount);
  return `${word} ${checkCount === 1 ? 'check' : 'checks'}, using fresh server reads`;
}

function checkTone(state: OutreachV3CheckState): 'pass' | 'review' | 'blocked' {
  return state === 'pass' ? 'pass' : state === 'blocked' ? 'blocked' : 'review';
}

function attachmentLabel(id: string, attachments: OutreachAttachment[]): string {
  return attachments.find((item) => item.id === id)?.fileName ?? `Attached file ${id.slice(0, 8)}`;
}

function draftVersionLabel(draft: OutreachV3DraftArtifact): number {
  return draft.current?.version ?? draft.currentVersion;
}

function errorText(error: unknown, fallback: string): string {
  const message =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : '';
  return message || fallback;
}

/* ------------------------------------------------------------------ *
 * The step
 * ------------------------------------------------------------------ */

export interface OutreachSendStepProps extends OutreachBuilderStepCommon {
  /** The connected mailbox this campaign sends from, or null when none is. */
  senderLabel: string | null;
}

export function OutreachSendStep(props: OutreachSendStepProps): JSX.Element {
  const api = useApi();
  const { session, sessionId } = props;

  const [timing, setTiming] = useState<SendTiming>('now');
  const [pacing, setPacing] = useState<SendPacing>('steady');
  const [partialChoice, setPartialChoice] = useState<PartialChoice>('ready');
  const [acknowledged, setAcknowledged] = useState(false);
  const [testGenerationKey, setTestGenerationKey] = useState('');
  const [tested, setTested] = useState(false);
  const [preflightState, setPreflightState] = useState<{
    result: OutreachV3ServerPreflight;
    at: Date;
    fingerprint: string;
  } | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request key per mount: retrying a failed confirmation must not create a
  // second send record, which is the whole point of the server's idempotency.
  const [sendRequestKey] = useState(() => randomKey('send'));

  const sponsorClientId = outreachSponsorFromSpec(session).clientId;

  const draftsQuery = useQuery({
    queryKey: ['outreach-v3', 'drafts', sessionId],
    queryFn: () => listOutreachV3Drafts(api, sessionId),
  });
  const planQuery = useQuery({
    queryKey: ['outreach-v3', 'plan', sessionId],
    queryFn: () => getOutreachV3GenerationPlan(api, sessionId),
  });
  const settingsQuery = useQuery({
    queryKey: ['outreach-v3', 'send-settings', sessionId],
    queryFn: () => getOutreachV3SendSettings(api, sessionId),
  });
  const attachmentsQuery = useQuery({
    queryKey: ['outreach-v3', 'attachments', sponsorClientId],
    queryFn: () => listOutreachAttachments(api, sponsorClientId),
  });
  // The Campaign Spec stores a template's structure but not its name, so the
  // "Format" row reads the name from the template application receipt — the one
  // real record of which template this campaign came from.
  const provenanceQuery = useQuery({
    queryKey: ['outreach-v3', 'template-provenance', sessionId],
    queryFn: () => getOutreachTemplateProvenance(api, sessionId),
  });

  // Until the drafts, plan and settings are in, a preflight would be run
  // against data the step cannot yet show — and the verdict would be discarded
  // the moment they arrive, because they are part of its fingerprint.
  const dataLoading =
    draftsQuery.isPending || planQuery.isPending || settingsQuery.isPending;
  const drafts = draftsQuery.data ?? [];
  const plan: OutreachV3GenerationPlan | null = planQuery.data ?? null;
  const settings = settingsQuery.data ?? null;
  const attachments = attachmentsQuery.data ?? [];
  const templateName = provenanceQuery.data?.templateName ?? null;

  const selectedTargets = outreachSelectedTargets(session);
  const blockedTargets = outreachBlockedTargets(session);
  const selectedCount = selectedTargets.length;
  const blockedCount = blockedTargets.length;
  const readyCount = outreachReadyRecipientCount(selectedCount, blockedCount, partialChoice);

  // `needsAcknowledgment` and `holdsAll` do not depend on whether preflight has
  // run, and preflight's own input depends on them — so the gate is asked those
  // two questions first, and asked again below once the verdict is known.
  const choiceGate = outreachSendGate({
    preflightRan: false,
    blockedCount,
    partialChoice,
    acknowledged,
  });

  /**
   * The generation keys a held-out target owns. A slot is excluded only when
   * every one of its recipients is blocked — a shared-thread slot with one
   * sendable recipient still goes out.
   */
  const blockedGenerationKeys = useMemo(() => {
    const blockedKeys = new Set(blockedTargets.map((target) => target.targetKey));
    if (!plan) return [] as string[];
    return plan.slots
      .filter(
        (slot) =>
          slot.recipients.length > 0 &&
          slot.recipients.every((recipient) => blockedKeys.has(recipient.targetKey)),
      )
      .map((slot) => slot.generationKey)
      .sort();
  }, [blockedTargets, plan]);

  const needsAcknowledgment = choiceGate.needsAcknowledgment;
  const preflightInput: OutreachV3PreflightInput = {
    excludedGenerationKeys: partialChoice === 'ready' ? blockedGenerationKeys : [],
    acknowledgeHeldOut: !needsAcknowledgment || acknowledged,
  };

  /**
   * Everything a preflight verdict was computed against. When any of it moves,
   * the stored result is no longer about the current campaign, so it is dropped
   * rather than kept behind a "Last checked" line that would then be false —
   * the prototype never invalidates and its own copy can lie.
   */
  const preflightFingerprint = JSON.stringify([
    session?.currentStateVersion ?? null,
    session?.specHash ?? null,
    settings?.settingsHash ?? null,
    settings?.stateVersion ?? null,
    drafts.map((draft) => `${draft.generationKey}:${draft.current?.id ?? ''}:${draft.currentVersion}`),
    preflightInput.excludedGenerationKeys,
    preflightInput.acknowledgeHeldOut,
  ]);
  const preflight =
    preflightState && preflightState.fingerprint === preflightFingerprint ? preflightState : null;
  const checks: OutreachV3NamedPreflightCheck[] = preflight?.result.checks ?? [];
  const attentionChecks = checks.filter((check) => check.state !== 'pass');
  const visibleChecks = attentionChecks.length ? attentionChecks : checks;
  const hidPassingChecks = attentionChecks.length > 0 && attentionChecks.length < checks.length;

  const sendGate = outreachSendGate({
    preflightRan: Boolean(preflight),
    blockedCount,
    partialChoice,
    acknowledged,
  });
  const serverEligible = preflight?.result.eligible ?? false;
  const canSend = sendGate.canSend && serverEligible && timing === 'now';
  const gateReason = !sendGate.canSend
    ? sendGate.reason
    : timing === 'schedule'
      ? 'Choose “Send now” — scheduled delivery has no server contract.'
      : !serverEligible
        ? 'Resolve the blocking checks or hold eligible recipients out.'
        : sendGate.reason;

  const effectiveFormat = outreachEffectiveEmailFormat(session, props.campaignType);
  const attachmentIds = settings?.attachmentIds ?? [];

  const setupRows: Array<{ key: string; value: string; unset: boolean }> = [
    {
      key: 'How many',
      value: outreachSendHowManyRow({
        selectedCount,
        blockedCount,
        readyCount,
        holdsAll: sendGate.holdsAll,
      }),
      unset: selectedCount === 0,
    },
    {
      key: 'From',
      value: props.senderLabel ?? 'No mailbox connected',
      unset: props.senderLabel === null,
    },
    {
      key: 'When',
      value:
        timing === 'now'
          ? `Straight away, ${pacing === 'steady' ? 'spread steadily' : 'as quickly as provider policy allows'}`
          : 'Scheduled — server creates immediate intents only',
      unset: false,
    },
    {
      key: 'Format',
      value: `${effectiveFormat.name} · ${templateName ?? 'No template'}`,
      unset: templateName === null,
    },
    {
      key: 'Signature',
      value: settings
        ? settings.appendSignature
          ? 'Append your current Capiro signature'
          : 'No signature'
        : 'Not set',
      unset: !settings,
    },
    {
      key: 'Attachments',
      value: !settings
        ? 'Not set'
        : attachmentIds.length === 0
          ? 'No attachments'
          : attachmentIds.map((id) => attachmentLabel(id, attachments)).join(' · '),
      unset: !settings,
    },
  ];

  const testOptions = drafts.map((draft) => ({
    generationKey: draft.generationKey,
    label: `${recipientPresentation(draft, plan).label} · V${draftVersionLabel(draft)}`,
  }));
  const activeTestKey = testGenerationKey || testOptions.at(0)?.generationKey || '';

  async function runPreflight(): Promise<void> {
    setPreflightBusy(true);
    setError(null);
    try {
      const result = await runOutreachV3Preflight(api, sessionId, preflightInput);
      setPreflightState({ result, at: new Date(), fingerprint: preflightFingerprint });
      props.toast('Preflight run against the current exact versions');
    } catch (cause) {
      setError(errorText(cause, 'Preflight could not run.'));
    } finally {
      setPreflightBusy(false);
    }
  }

  async function sendTest(): Promise<void> {
    if (!activeTestKey) return;
    setTestBusy(true);
    setError(null);
    try {
      await createOutreachV3TestSend(api, sessionId, {
        ...preflightInput,
        requestKey: randomKey('test'),
        testGenerationKey: activeTestKey,
      });
      setTested(true);
      props.toast('Test send created · your mailbox only');
    } catch (cause) {
      setError(errorText(cause, 'The test send could not be created.'));
    } finally {
      setTestBusy(false);
    }
  }

  async function confirmSend(): Promise<void> {
    setSendBusy(true);
    setError(null);
    try {
      await createOutreachV3SendIntent(api, sessionId, {
        ...preflightInput,
        requestKey: sendRequestKey,
      });
      setConfirmOpen(false);
      props.toast(`One durable send record created · ${readyCount} queued`);
      // What follows a real send — progress, delivery reconciliation, results —
      // belongs to the workspace, not to this step.
      props.onNext();
    } catch (cause) {
      setError(errorText(cause, 'The send record could not be created.'));
    } finally {
      setSendBusy(false);
    }
  }

  return (
    <div className="ocb-step osend">
      {/* 1 — What will happen */}
      <section className="ocb-accent-panel osend-summary" aria-labelledby="osend-summary-title">
        <span className="ocb-eyebrow">Before this goes out</span>
        <span className="osend-summary__title" id="osend-summary-title">
          What will happen
        </span>
        <div className="ocb-kv ocb-kv--accent osend-summary__rows">
          {setupRows.map((row) => (
            <div className="ocb-kv__row" key={row.key}>
              <span className="ocb-kv__key ocb-eyebrow--tight">{row.key}</span>
              <span className="ocb-kv__value" data-unset={row.unset ? 'true' : undefined}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 2 — Timing, pacing, partials */}
      <section className="ocb-card osend-panel" aria-labelledby="osend-timing-title">
        <span className="ocb-eyebrow">Timing</span>
        <h3 className="osend-panel__title" id="osend-timing-title">
          When should it go?
        </h3>
        <div className="osend-tiles" role="radiogroup" aria-labelledby="osend-timing-title">
          {TIMING_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.id}
              role="radio"
              aria-checked={timing === option.id}
              className="ocb-option ocb-option--compact osend-tile"
              data-selected={timing === option.id ? 'true' : undefined}
              onClick={() => setTiming(option.id)}
            >
              <span className="ocb-option__title osend-choice__title">{option.label}</span>
              <span className="ocb-option__desc osend-choice__desc">{option.desc}</span>
            </button>
          ))}
        </div>
        {timing === 'schedule' ? <p className="ocb-note ocb-note--warn">{SCHEDULE_CAVEAT}</p> : null}

        <span className="ocb-eyebrow ocb-eyebrow--inline osend-subeyebrow" id="osend-pacing-label">
          Pacing
        </span>
        <div className="osend-tiles" role="radiogroup" aria-labelledby="osend-pacing-label">
          {PACING_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.id}
              role="radio"
              aria-checked={pacing === option.id}
              className="ocb-option ocb-option--compact osend-tile"
              data-selected={pacing === option.id ? 'true' : undefined}
              onClick={() => setPacing(option.id)}
            >
              <span className="ocb-option__title osend-choice__title">{option.label}</span>
              <span className="ocb-option__desc osend-choice__desc">{option.desc}</span>
            </button>
          ))}
        </div>

        <span className="ocb-eyebrow ocb-eyebrow--inline osend-subeyebrow" id="osend-partial-label">
          If some recipients are not ready
        </span>
        <div className="osend-partials" role="radiogroup" aria-labelledby="osend-partial-label">
          {PARTIAL_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.id}
              role="radio"
              aria-checked={partialChoice === option.id}
              className="ocb-option ocb-option--compact"
              data-selected={partialChoice === option.id ? 'true' : undefined}
              onClick={() => {
                setPartialChoice(option.id);
                // The acknowledgment is about one specific choice; changing the
                // choice must not carry a consent granted under the other one.
                setAcknowledged(false);
              }}
            >
              <span className="ocb-radio" data-on={partialChoice === option.id ? 'true' : 'false'} />
              <span className="ocb-option__body">
                <span className="ocb-option__title osend-choice__title">{option.label}</span>
                <span className="ocb-option__desc osend-choice__desc">{option.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* 3 — Test send */}
      <section className="ocb-inset osend-test">
        <span className="osend-test__copy">
          <span className="osend-test__title">Send one to yourself first</span>
          <span className="osend-test__sub">
            The selected exact version goes only to your own connected mailbox.
          </span>
        </span>
        {testOptions.length ? (
          <>
            <label className="osend-test__select">
              <span className="osend-visually-hidden">Draft to test</span>
              <select
                className="ocb-select osend-select"
                value={activeTestKey}
                onChange={(event) => setTestGenerationKey(event.target.value)}
              >
                {testOptions.map((option) => (
                  <option value={option.generationKey} key={option.generationKey}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ocb-btn ocb-btn--secondary ocb-btn--sm"
              disabled={testBusy || dataLoading || !activeTestKey}
              onClick={() => void sendTest()}
            >
              {testBusy ? <Loader2 size={14} className="osend-spin" /> : null}
              {tested ? 'Send another test' : 'Send a test to me'}
            </button>
            {tested ? <span className="osend-chip">Test send created</span> : null}
          </>
        ) : (
          <p className="ocb-note osend-test__empty">
            No drafts yet. Generate the drafts first — a test send goes out as one exact version.
          </p>
        )}
      </section>

      {/* 4 — Preflight */}
      <section className="ocb-card osend-panel" aria-labelledby="osend-preflight-title">
        <div className="osend-preflight__head">
          <span className="osend-preflight__copy">
            <span className="ocb-eyebrow">Preflight</span>
            <span className="osend-panel__title" id="osend-preflight-title">
              {outreachPreflightHeading(preflight ? checks.length : null)}
            </span>
            <span className="osend-preflight__meta">
              {preflight
                ? `Last checked ${formatClock(preflight.at)} · ${checks.length} ${checks.length === 1 ? 'check' : 'checks'}`
                : 'Not checked for the current versions.'}
            </span>
          </span>
          <button
            type="button"
            className="ocb-btn ocb-btn--secondary ocb-btn--sm"
            disabled={preflightBusy || dataLoading}
            onClick={() => void runPreflight()}
          >
            {preflightBusy ? (
              <Loader2 size={14} className="osend-spin" />
            ) : (
              <RefreshCcw size={14} className="osend-refresh" />
            )}
            {preflight ? 'Run them again' : 'Run the checks'}
          </button>
        </div>

        {preflight ? (
          <div className="osend-checks">
            {visibleChecks.map((check) => {
              const tone = checkTone(check.state);
              return (
                <div className="osend-check" data-tone={tone} key={check.key}>
                  <span className="osend-check__icon" aria-hidden="true">
                    {tone === 'pass' ? (
                      <CheckSquare size={16} />
                    ) : tone === 'blocked' ? (
                      <CircleAlert size={16} />
                    ) : (
                      <AlertTriangle size={16} />
                    )}
                  </span>
                  <span className="osend-check__body">
                    <span className="osend-check__label">{check.label}</span>
                    <span className="osend-check__detail">{check.detail}</span>
                  </span>
                </div>
              );
            })}
            {checks.length === 0 ? (
              <p className="ocb-note">The server returned no checks for this campaign.</p>
            ) : null}
            {hidPassingChecks ? <p className="ocb-note">{PREFLIGHT_FOOTNOTE}</p> : null}
          </div>
        ) : null}
      </section>

      {/* 5 — Held-out recipients */}
      {blockedCount > 0 ? (
        <section className="osend-held">
          <span className="osend-held__title">
            {blockedCount === 1
              ? '1 recipient is not ready'
              : `${blockedCount} recipients are not ready`}
          </span>
          <span className="osend-held__sub">
            {partialChoice === 'ready'
              ? 'They are held out of this send and receive nothing.'
              : 'The campaign stays blocked until they are ready.'}
          </span>
          {blockedTargets.map((target) => (
            <span className="osend-held__row" key={target.targetKey}>
              <strong>{target.displayName}</strong> ·{' '}
              {target.emailStatus === 'invalid'
                ? 'email address failed verification'
                : 'no verified email address'}
            </span>
          ))}
          {needsAcknowledgment ? (
            <label className="osend-ack">
              <input
                type="checkbox"
                className="osend-ack__input"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span className="ocb-check" data-on={acknowledged ? 'true' : 'false'} aria-hidden="true">
                <Check size={12} />
              </span>
              <span className="osend-ack__body">
                <span className="osend-ack__label">
                  I understand those recipients will not be contacted
                </span>
                <span className="osend-ack__sub">
                  This does not resolve their blockers or send to them.
                </span>
              </span>
            </label>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <p className="ocb-note ocb-note--warn" role="alert">
          {error}
        </p>
      ) : null}

      {/* 6 — Send */}
      <div className="osend-send">
        <button
          type="button"
          className="ocb-btn ocb-btn--primary ocb-btn--lg"
          disabled={!canSend || dataLoading || props.busy || sendBusy}
          onClick={() => setConfirmOpen(true)}
        >
          {props.primaryLabel}
        </button>
        <span className="osend-send__gate">{gateReason}</span>
      </div>

      {confirmOpen ? (
        <OutreachSendConfirmDialog
          count={readyCount}
          held={partialChoice === 'ready' ? blockedCount : 0}
          sender={props.senderLabel ?? 'No mailbox connected'}
          pending={sendBusy}
          error={error}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => void confirmSend()}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

/**
 * The prototype's own gate copy promises "The confirmation dialog is the only
 * real-send trigger" and then fires the send straight from the button. This is
 * the dialog it describes, and nothing else calls `createOutreachV3SendIntent`.
 *
 * `SendConfirmDialog` in outreach-v3-phase1-results.tsx says the same things,
 * but its styling hangs off `--ov3p1-*` custom properties declared on
 * `.ov3p1-shell` — and `EngagementDialog` portals to `.engagement-vnext`, which
 * is outside that shell. Reused verbatim here it would render unstyled, so the
 * copy is reused and the chrome is the builder's own tokens.
 */
function OutreachSendConfirmDialog(props: {
  count: number;
  held: number;
  sender: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const plural = props.count === 1 ? 'email' : 'emails';
  return (
    <EngagementDialog
      open
      eyebrow="Final confirmation"
      title={`Send ${props.count} ${plural} now?`}
      description="Capiro will create one durable send record. Refreshing or opening another tab will not create a second send."
      width={560}
      busy={props.pending}
      error={props.error}
      onClose={props.onClose}
      footer={
        <>
          <button
            type="button"
            className="ocb-btn ocb-btn--secondary"
            disabled={props.pending}
            onClick={props.onClose}
          >
            Go back
          </button>
          <button
            type="button"
            className="ocb-btn ocb-btn--primary"
            disabled={props.pending}
            onClick={props.onConfirm}
          >
            {props.pending ? <Loader2 size={15} className="osend-spin" /> : null}
            Send {props.count} {plural}
          </button>
        </>
      }
    >
      <div className="osend-confirm">
        {props.held ? (
          <p className="osend-confirm__held">
            {props.held === 1
              ? '1 recipient will remain held. They will not receive an email.'
              : `${props.held} recipients will remain held. They will not receive an email.`}
          </p>
        ) : null}
        <div className="ocb-kv osend-confirm__rows">
          <div className="ocb-kv__row">
            <span className="ocb-kv__key ocb-eyebrow--tight">Recipients</span>
            <span className="ocb-kv__value">{props.count}</span>
          </div>
          <div className="ocb-kv__row">
            <span className="ocb-kv__key ocb-eyebrow--tight">Sender</span>
            <span className="ocb-kv__value">{props.sender}</span>
          </div>
          <div className="ocb-kv__row">
            <span className="ocb-kv__key ocb-eyebrow--tight">Timing</span>
            <span className="ocb-kv__value">Start now</span>
          </div>
          <div className="ocb-kv__row">
            <span className="ocb-kv__key ocb-eyebrow--tight">Authority</span>
            <span className="ocb-kv__value">Exact approved versions only</span>
          </div>
        </div>
      </div>
    </EngagementDialog>
  );
}
