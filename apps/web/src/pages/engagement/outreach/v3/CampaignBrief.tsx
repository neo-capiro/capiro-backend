import { Check, CircleAlert, LockKeyhole } from 'lucide-react';
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
}

export function CampaignBrief({ session, clients, currentStage }: CampaignBriefProps) {
  const { spec, readiness } = session;
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
  const targetCriteriaReady = canonicalBoolean(
    readiness.targetCriteriaReady,
    spec.targeting.criteria !== null,
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
  const strategyReady = canonicalBoolean(
    readiness.strategyReady,
    Boolean(
      spec.strategy.campaignAngle &&
        spec.strategy.tone &&
        spec.strategy.length !== 'undecided',
    ),
  );

  const rows = [
    {
      label: 'Goal',
      value: joinMeaningful(
        [spec.goal.desiredOutcome, spec.goal.ask.text, spec.goal.topic],
        'Not defined',
      ),
      ready: goalReady,
    },
    { label: 'Sponsor', value: sponsor, ready: sponsorReady },
    {
      label: 'Targets',
      value: spec.targeting.selectedTargetRefs.length
        ? `${spec.targeting.selectedTargetRefs.length} selected${
            targetCriteriaReady ? '' : ' · criteria open'
          }`
        : 'None selected',
      ready: targetCriteriaReady && targetsReady,
    },
    {
      label: 'Delivery',
      value:
        spec.delivery.pattern === 'undecided'
          ? 'Undecided'
          : `${spec.delivery.pattern.replaceAll('_', ' ')} · ${spec.delivery.personalization}`,
      ready: deliveryReady,
    },
    {
      label: 'Context',
      value: acceptedContext
        ? `${acceptedContext} accepted${
            readiness.contextEvidenceReady === false ? ' · evidence review needed' : ''
          }`
        : 'Not reviewed',
      ready: contextReady,
    },
    {
      label: 'Strategy',
      value: joinMeaningful(
        [spec.strategy.campaignAngle, spec.strategy.tone, spec.strategy.length],
        'Not set',
      ),
      ready: strategyReady,
    },
  ];

  return (
    <aside className="ov3-brief" aria-label="Canonical campaign brief">
      <header className="ov3-brief__header">
        <div>
          <span className="ov3-eyebrow">Campaign brief</span>
          <h3>{spec.goal.topic || session.session.title || 'New outreach campaign'}</h3>
        </div>
        <span className="ov3-version">V{session.currentStateVersion}</span>
      </header>
      <p className="ov3-brief__help">
        This is the canonical Campaign Spec. Meri may propose changes; only a confirmed
        command or Apply action updates it.
      </p>

      <dl className="ov3-brief__rows">
        {rows.map((row) => (
          <div key={row.label} className={row.ready ? 'is-ready' : 'is-open'}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
            <span className="ov3-brief__state" aria-label={row.ready ? 'Complete' : 'Open'}>
              {row.ready ? <Check size={14} aria-hidden="true" /> : <CircleAlert size={14} />}
            </span>
          </div>
        ))}
      </dl>

      <div className="ov3-brief__footer">
        <div className="ov3-brief__stage">
          <span>Current decision</span>
          <strong>{STAGE_LABELS[currentStage]}</strong>
        </div>
        <div
          className={`ov3-brief__readiness ${planningBlockerCount ? 'is-blocked' : 'is-clear'}`}
        >
          <LockKeyhole size={15} aria-hidden="true" />
          <span>
            {planningBlockerCount
              ? `${planningBlockerCount} planning blocker${planningBlockerCount === 1 ? '' : 's'}`
              : 'Planning state validated'}
          </span>
        </div>
      </div>
    </aside>
  );
}