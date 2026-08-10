import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  LockKeyhole,
  Pencil,
} from 'lucide-react';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachV3SessionEnvelope, OutreachV3Stage } from './contracts.js';
import { outreachV3PlanningBlockerCodes } from './useOutreachV3Session.js';

const STAGE_LABELS: Record<OutreachV3Stage, string> = {
  goal: 'Goal',
  sponsor: 'Sponsor',
  targets: 'Targets',
  delivery: 'Delivery',
  context: 'Context',
  strategy: 'Strategy',
  ready_for_generation: 'Planning complete',
};

function joinMeaningful(values: Array<string | null | undefined>, fallback: string): string {
  const result = values.map((value) => value?.trim()).filter(Boolean).join(' · ');
  return result || fallback;
}

function canonicalBoolean(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export interface CampaignBriefProps {
  session: OutreachV3SessionEnvelope;
  clients: Client[];
  currentStage: OutreachV3Stage;
  onSelectStage?: (stage: OutreachV3Stage) => void;
}

export function CampaignBrief({
  session,
  clients,
  currentStage,
  onSelectStage,
}: CampaignBriefProps) {
  const { spec, readiness } = session;
  const [open, setOpen] = useState(currentStage === 'goal' || currentStage === 'sponsor');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) return;
    setOpen(currentStage === 'goal' || currentStage === 'sponsor');
  }, [currentStage, touched]);

  const clientNames = new Map(clients.map((client) => [client.id, client.name]));
  const sponsor = (() => {
    switch (spec.sponsor.kind) {
      case 'client':
      case 'multi_client':
        return spec.sponsor.clientRefs
          .map((ref) => clientNames.get(ref.clientId) ?? 'Authorized client')
          .join(', ');
      case 'coalition':
        return spec.sponsor.label ?? 'Coalition';
      case 'firm':
        return 'Firm-wide';
      case 'internal_team':
        return 'Internal team';
      case 'none':
        return 'No formal sponsor';
      default:
        return 'Not selected';
    }
  })();
  const acceptedContext =
    spec.context.requiredPolicyRefs.length +
    spec.context.writingGuidanceRefs.length +
    spec.context.campaignFactRefs.length +
    spec.context.targetSpecificRefs.length +
    spec.context.groupSafeRefs.length;
  const planningBlockerCount = outreachV3PlanningBlockerCodes(readiness).length;

  const goalReady = canonicalBoolean(
    readiness.goalReady,
    Boolean(spec.goal.goal && spec.goal.objective),
  );
  const sponsorReady = canonicalBoolean(
    readiness.sponsorResolved,
    spec.sponsor.kind !== 'undecided',
  );
  const targetsReady = canonicalBoolean(
    readiness.targetsReady,
    spec.targeting.selectedTargetRefs.length > 0,
  );
  const deliveryReady = canonicalBoolean(
    readiness.deliveryReady,
    spec.delivery.pattern !== 'undecided' && spec.delivery.personalization !== 'undecided',
  );
  const contextReady =
    canonicalBoolean(readiness.contextReady, acceptedContext > 0) &&
    canonicalBoolean(readiness.contextEvidenceReady, true);

  const ask = spec.goal.ask.mode === 'none'
    ? 'No formal ask — informational update only'
    : spec.goal.ask.text || 'Not set';
  const delivery = spec.delivery.pattern === 'undecided'
    ? 'Not set'
    : `${spec.delivery.pattern.replaceAll('_', ' ')} · ${spec.delivery.personalization}`;
  const readinessText = planningBlockerCount
    ? `${planningBlockerCount} planning blocker${planningBlockerCount === 1 ? '' : 's'}`
    : currentStage === 'ready_for_generation'
      ? 'Planning complete'
      : 'Planning state validated';

  const rows: Array<{
    label: string;
    value: string;
    ready: boolean;
    stage: OutreachV3Stage;
  }> = [
    { label: 'Goal', value: spec.goal.goal || spec.goal.objective || 'Not defined', ready: goalReady, stage: 'goal' },
    { label: 'Topic', value: spec.goal.topic || 'Not set', ready: Boolean(spec.goal.topic), stage: 'goal' },
    { label: 'Ask', value: ask, ready: spec.goal.ask.mode !== 'undecided', stage: 'goal' },
    { label: 'Sponsor', value: sponsor, ready: sponsorReady, stage: 'sponsor' },
    {
      label: 'Targets',
      value: spec.targeting.selectedTargetRefs.length
        ? `${spec.targeting.selectedTargetRefs.length} selected`
        : 'None selected',
      ready: targetsReady,
      stage: 'targets',
    },
    { label: 'Delivery', value: delivery, ready: deliveryReady, stage: 'delivery' },
    {
      label: 'Context health',
      value: acceptedContext
        ? `${acceptedContext} in use${readiness.contextEvidenceReady === false ? ' · evidence review needed' : ''}`
        : 'Not reviewed',
      ready: contextReady,
      stage: 'context',
    },
    { label: 'Readiness', value: readinessText, ready: planningBlockerCount === 0, stage: currentStage },
  ];

  const summary = [
    sponsor,
    spec.targeting.selectedTargetRefs.length
      ? `${spec.targeting.selectedTargetRefs.length} targets`
      : 'Targets not set',
    delivery,
    `${acceptedContext} context source${acceptedContext === 1 ? '' : 's'}`,
    currentStage === 'ready_for_generation' ? 'Plan ready' : `${STAGE_LABELS[currentStage]} in progress`,
  ].join(' · ');

  return (
    <section className={`ov3-brief-strip ${open ? 'is-open' : 'is-collapsed'}`} aria-label="Canonical campaign brief">
      <button
        type="button"
        className="ov3-brief-strip__toggle"
        onClick={() => {
          setTouched(true);
          setOpen((value) => !value);
        }}
        aria-expanded={open}
      >
        <div className="ov3-brief-strip__identity">
          <span className="ov3-eyebrow">Campaign brief · V{session.currentStateVersion}</span>
          <strong>{spec.goal.topic || session.session.title || 'New outreach campaign'}</strong>
        </div>
        <span className="ov3-brief-strip__summary">{summary}</span>
        <span className={`ov3-brief-strip__health ${planningBlockerCount ? 'is-blocked' : 'is-clear'}`}>
          <LockKeyhole size={14} aria-hidden="true" />
          {planningBlockerCount ? `${planningBlockerCount} open` : 'Validated'}
        </span>
        {open ? <ChevronUp size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
      </button>

      {open ? (
        <div className="ov3-brief-strip__body">
          <p className="ov3-brief-strip__help">
            This is the canonical Campaign Spec. Meri may propose changes; only a confirmed command or Apply action updates it.
          </p>
          <dl className="ov3-brief-strip__rows">
            {rows.map((row) => (
              <div key={row.label} className={row.ready ? 'is-ready' : 'is-open'}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
                <span className="ov3-brief-strip__state" aria-label={row.ready ? 'Complete' : 'Open'}>
                  {row.ready ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}
                </span>
                {onSelectStage ? (
                  <button
                    type="button"
                    className="ov3-brief-strip__edit"
                    onClick={() => onSelectStage(row.stage)}
                  >
                    <Pencil size={12} aria-hidden="true" />
                    {row.ready ? 'Edit' : 'Open'}
                  </button>
                ) : null}
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
