import { useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriEvidenceTray — the expandable evidence surface beneath an assistant
 * answer: SOURCES · N / VERIFICATION / WORK PERFORMED / CONTEXT USED.
 * Pixel-parity port of the prototype's `trayOpen` block.
 *
 * BACKEND GAP: claim-level verification rows, work-performed step records and
 * the context-packet inspector have no vNext endpoints yet. All tabs render
 * prototype fixtures unless the caller passes real data through props.
 * Tracked in GAPS.md (Meri vNext — evidence tray feeds).
 *
 * Styling: real CSS classes (`.vnext-meri__evidence-*` in vnext-meri.css),
 * not inline styles — converted in the v6 turn-inspector pass, same playbook
 * as MeriWorkPerformed.tsx/MeriResearchProgress.tsx. The v6 rail's Thinking
 * and Evidence tabs (MeriThinkingTab.tsx, MeriEvidenceTab.tsx) share this
 * same class vocabulary rather than duplicating it — see the "Evidence
 * vocabulary" section of vnext-meri.css.
 */

/* ── Public data shapes ─────────────────────────────────────────────────── */

export interface MeriEvidenceSource {
  icon: MeriIconName;
  provider: string;
  date: string;
  title: string;
  snippet: string;
  locator: string;
}

export type MeriEvidenceStatTone = 'n' | 'g' | 'w' | 'b';

export interface MeriEvidenceStat {
  label: string;
  tone: MeriEvidenceStatTone;
}

export type MeriClaimState = 'verified' | 'inference' | 'unsupported' | 'conflict' | 'low';

export interface MeriEvidenceClaim {
  state: MeriClaimState;
  claim: string;
}

export type MeriWorkStepState = 'done' | 'running' | 'queued' | 'failed' | 'skipped';

export interface MeriWorkStep {
  state: MeriWorkStepState;
  title: string;
  detail: string;
}

export interface MeriContextItem {
  name: string;
  type: string;
  scope: 'FIRM' | 'CLIENT' | 'PERSONAL';
  auto: boolean;
  rationale: string;
  meta: string[];
}

export type MeriContextExclusionTone = 'n' | 'w' | 'b';

export interface MeriContextExclusion {
  name: string;
  reason: string;
  tone: MeriContextExclusionTone;
  restricted?: boolean;
}

export interface MeriContextPacket {
  degraded?: string | null;
  included: MeriContextItem[];
  excluded: MeriContextExclusion[];
  packet: string;
}

/* ── Prototype fixtures (screen B / P) ──────────────────────────────────── */

export const MERI_EVIDENCE_SOURCES: MeriEvidenceSource[] = [
  {
    icon: 'Bank',
    provider: 'CAPIRO INTELLIGENCE · COMMITTEE',
    date: 'AUG 14, 2026',
    title: 'HASC FY27 committee report',
    snippet:
      'The committee recommends $182.2M for the Improved Turbine Engine Program, an increase of $14.7M over the request, citing Army validation of the engine qualification schedule.',
    locator: 'REPORT P. 187',
  },
  {
    icon: 'File05',
    provider: 'CAPIRO INTELLIGENCE · REPORT LANGUAGE',
    date: 'AUG 14, 2026',
    title: 'Report language — fielding decision',
    snippet:
      'Directs the Secretary of the Army to report on the FY29 fielding decision not later than 180 days after enactment.',
    locator: '§ 214',
  },
  {
    icon: 'Coins01',
    provider: 'FY27 PRESIDENT’S BUDGET',
    date: 'MAR 2026',
    title: 'FY27 President’s Budget, Army R-1',
    snippet:
      'PE 0605053A requested at $167.5M. Engine procurement requested at $412.0M with no quantity change from FY26.',
    locator: 'PE 0605053A',
  },
  {
    icon: 'ClockRewind',
    provider: 'CAPIRO APPROPRIATIONS HISTORY',
    date: 'FY25–FY26',
    title: 'Prior-cycle appropriations behaviour',
    snippet:
      'In FY25 and FY26 HAC-D marked below HASC on this account. Both conference outcomes tracked the House defense appropriations position.',
    locator: '2 CYCLES',
  },
  {
    icon: 'Users02',
    provider: 'CAPIRO WORKSPACE · MEETING NOTE',
    date: 'AUG 13, 2026',
    title: 'Meeting — Calvert personal office',
    snippet:
      'Staff asked for a one-page district-impact summary before the subcommittee markup.',
    locator: 'NOTE 4',
  },
];

export const MERI_VERIFY_STATS: MeriEvidenceStat[] = [
  { label: 'CLAIMS CHECKED · 8', tone: 'n' },
  { label: 'VERIFIED · 5', tone: 'g' },
  { label: 'UNSUPPORTED · 2', tone: 'w' },
  { label: 'DISAGREEMENT · 1', tone: 'b' },
  { label: 'COVERAGE · 12 OF 14', tone: 'w' },
];

export const MERI_CLAIMS: MeriEvidenceClaim[] = [
  { state: 'verified', claim: 'HASC authorised $182.2M against a $167.5M request.' },
  { state: 'verified', claim: 'HAC-D appropriated $172.8M.' },
  { state: 'unsupported', claim: 'The committee voted it out unanimously.' },
  { state: 'unsupported', claim: 'No objection was recorded (negative claim, unverifiable).' },
  { state: 'conflict', claim: 'The line is a procurement item.' },
];

export const MERI_WORK_PLAN =
  'Test each premise in the question separately against the record, and report which are supported, which are reversed and which cannot be verified either way.';

export const MERI_WORK_STATS = ['6 SOURCES', '5 STEPS', '1 DISAGREEMENT', '1 UNVERIFIABLE NEGATIVE'];

export const MERI_WORK_STEPS: MeriWorkStep[] = [
  { state: 'done', title: 'Tested premise: funding went up', detail: 'TRUE FOR AUTHORISATION · FALSE FOR APPROPRIATION' },
  { state: 'done', title: 'Searched for a roll-call record', detail: '0 RESULTS · CANNOT VERIFY NEGATIVE' },
  { state: 'done', title: 'Resolved line classification', detail: 'CONFLICT · PROCUREMENT VS PROGRAM ELEMENT' },
  { state: 'done', title: 'Reconciled figures', detail: '3 FIGURES · ALL MATCHED' },
  { state: 'skipped', title: 'Composed a confirming answer', detail: 'SKIPPED · PREMISE NOT SUPPORTED' },
];

export const MERI_ASSUMPTIONS = ['No assumption was substituted for the missing vote record.'];

export const MERI_CONTEXT_PACKET: MeriContextPacket = {
  degraded:
    'The roll-call source is unavailable, so no claim about the vote margin can be verified in either direction.',
  included: [
    {
      name: 'Lockheed Martin — client profile',
      type: 'CLIENT RECORD',
      scope: 'CLIENT',
      auto: true,
      rationale: 'Thread is scoped to this client, so the profile is always in context.',
      meta: ['AUTHORITY · CLIENT OF RECORD', 'LIFECYCLE · ACTIVE', 'AS OF AUG 14, 2026', 'CONFIRMED AUG 14, 2026'],
    },
    {
      name: 'FY27 rotorcraft strategy',
      type: 'STRATEGY',
      scope: 'CLIENT',
      auto: false,
      rationale: 'You added this strategy to the thread on Aug 12. Twelve live nodes were read.',
      meta: ['AUTHORITY · STRATEGY OWNER', 'LIFECYCLE · ACTIVE', 'AS OF AUG 15, 2026', 'CONFIRMED AUG 15, 2026'],
    },
    {
      name: 'Stephanie Bonk prefers one-page updates',
      type: 'MEMORY',
      scope: 'CLIENT',
      auto: true,
      rationale:
        'Retrieved because the request touches client-facing format. Approved to client memory on Aug 4.',
      meta: ['AUTHORITY · YOU APPROVED', 'LIFECYCLE · ACTIVE', 'LEARNED AUG 4, 2026', 'EXPIRES · NONE'],
    },
  ],
  excluded: [
    { name: 'HubSpot activity — Lockheed', reason: 'REAUTHENTICATION EXPIRED', tone: 'w' },
    { name: 'FY26 rotorcraft strategy', reason: 'SUPERSEDED', tone: 'n' },
    { name: 'Shield AI client profile', reason: 'WRONG CLIENT', tone: 'n' },
    { name: 'Restricted item', reason: 'ABOVE YOUR SENSITIVITY LEVEL', tone: 'b', restricted: true },
    { name: 'Q2 engagement summary', reason: 'CONTEXT BUDGET LIMIT', tone: 'n' },
    { name: 'Committee roll-call feed', reason: 'SOURCE MISSING', tone: 'b' },
  ],
  packet: 'CONTEXT PACKET 2D19-77E0 · COMPILED AUG 16, 9:41 AM',
};

/* ── Icon + label lookups (colour now lives in CSS via data-state/data-tone) ── */

const CLAIM_META: Record<MeriClaimState, { state: string; icon: MeriIconName }> = {
  verified: { state: 'VERIFIED · TIED TO A CITED LOCATOR', icon: 'Check' },
  inference: { state: 'INFERENCE · DERIVED, NOT QUOTED', icon: 'Diamond01' },
  unsupported: { state: 'UNSUPPORTED · NO EVIDENCE FOUND', icon: 'AlertTriangle' },
  conflict: { state: 'SOURCES DISAGREE', icon: 'SwitchVertical01' },
  low: { state: 'LOW CONFIDENCE · SINGLE WEAK SOURCE', icon: 'HelpCircle' },
};

const STEP_META: Record<MeriWorkStepState, { state: string; icon: MeriIconName; spin?: boolean }> = {
  done: { state: 'DONE', icon: 'Check' },
  running: { state: 'RUNNING', icon: 'Loading01', spin: true },
  queued: { state: 'QUEUED', icon: 'Clock' },
  failed: { state: 'FAILED', icon: 'XClose' },
  skipped: { state: 'SKIPPED', icon: 'SlashCircle01' },
};

type TrayTab = 'sources' | 'verify' | 'work' | 'ctx';

interface MeriEvidenceTrayProps {
  /** Reserved for wiring to live turn data; fixtures render when absent. */
  controller?: MeriChatController;
  sources?: MeriEvidenceSource[];
  verifyStats?: MeriEvidenceStat[];
  claims?: MeriEvidenceClaim[];
  plan?: string;
  workStats?: string[];
  steps?: MeriWorkStep[];
  assumptions?: string[];
  context?: MeriContextPacket;
  initialTab?: TrayTab;
  onOpenSource?: (source: MeriEvidenceSource, index: number) => void;
  onReviewContext?: () => void;
}

export function MeriEvidenceTray({
  sources = [],
  verifyStats = [],
  claims = [],
  plan = '',
  workStats = [],
  steps = [],
  assumptions = [],
  context = { degraded: 'Evidence is not available for this answer.', included: [], excluded: [], packet: 'EVIDENCE UNAVAILABLE' },
  initialTab = 'sources',
  onOpenSource,
  onReviewContext,
}: MeriEvidenceTrayProps) {
  const [tab, setTab] = useState<TrayTab>(initialTab);

  const tabs: Array<{ key: TrayTab; label: string; icon: MeriIconName }> = [
    { key: 'sources', label: `SOURCES · ${sources.length}`, icon: 'File05' },
    { key: 'verify', label: 'VERIFICATION', icon: 'ShieldTick' },
    { key: 'work', label: 'WORK PERFORMED', icon: 'CpuChip01' },
    { key: 'ctx', label: 'CONTEXT USED', icon: 'Sliders02' },
  ];

  return (
    <div className="vnext-meri__evidence-tray">
      <div className="vnext-meri__evidence-tabs" role="tablist" aria-label="Evidence">
        {tabs.map((t) => {
          const on = tab === t.key;
          return (
            <button
              type="button"
              key={t.key}
              role="tab"
              aria-selected={on}
              className={`vnext-meri__evidence-tab${on ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <MeriIcon name={t.icon} size={13} />
              <span className="vnext-meri__evidence-tab-label">{t.label}</span>
            </button>
          );
        })}
      </div>

      {tab === 'sources' ? (
        <div className="vnext-meri__evidence-tab-body">
          <div className="vnext-meri__evidence-source-list">
            {sources.map((source, index) => (
              <button
                type="button"
                key={`${source.locator}-${index}`}
                className="vnext-meri__evidence-source-row"
                onClick={() => onOpenSource?.(source, index)}
              >
                <span className="vnext-meri__evidence-source-tile">
                  <MeriIcon name={source.icon} size={13} />
                </span>
                <span className="vnext-meri__evidence-source-body">
                  <span className="vnext-meri__evidence-source-meta">
                    <span className="vnext-meri__evidence-source-provider">{source.provider}</span>
                    <span className="vnext-meri__evidence-source-date">{source.date}</span>
                  </span>
                  <span className="vnext-meri__evidence-source-title">
                    [{index + 1}] {source.title}
                  </span>
                  <span className="vnext-meri__evidence-source-snippet">{source.snippet}</span>
                </span>
                <span className="vnext-meri__evidence-source-locator">{source.locator}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {tab === 'verify' ? (
        <div className="vnext-meri__evidence-tab-body">
          <div className="vnext-meri__evidence-stat-row">
            {verifyStats.map((stat) => (
              <span key={stat.label} className="vnext-meri__evidence-stat-pill" data-tone={stat.tone}>
                {stat.label}
              </span>
            ))}
          </div>
          <div className="vnext-meri__evidence-claim-list">
            {claims.map((claim, index) => {
              const meta = CLAIM_META[claim.state];
              return (
                <div key={`${claim.claim}-${index}`} className="vnext-meri__evidence-claim-row" data-state={claim.state}>
                  <span className="vnext-meri__evidence-claim-dot">
                    <MeriIcon name={meta.icon} size={11} />
                  </span>
                  <span className="vnext-meri__evidence-claim-body">
                    <span className="vnext-meri__evidence-claim-text">{claim.claim}</span>
                    <span className="vnext-meri__evidence-claim-state">{meta.state}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === 'work' ? (
        <div className="vnext-meri__evidence-tab-body">
          <div className="vnext-meri__evidence-plan">
            <div className="vnext-meri__evidence-plan-label">PLAN</div>
            <div className="vnext-meri__evidence-plan-text">{plan}</div>
          </div>
          <div className="vnext-meri__evidence-stat-row">
            {workStats.map((stat) => (
              <span key={stat} className="vnext-meri__evidence-stat-pill" data-tone="n">
                {stat}
              </span>
            ))}
          </div>
          <div className="vnext-meri__evidence-step-list">
            {steps.map((step, index) => {
              const meta = STEP_META[step.state];
              return (
                <div key={`${step.title}-${index}`} className="vnext-meri__evidence-step-row" data-state={step.state}>
                  <span className="vnext-meri__evidence-step-dot">
                    <MeriIcon name={meta.icon} size={11} />
                  </span>
                  <span className="vnext-meri__evidence-step-body">
                    <span className="vnext-meri__evidence-step-title">{step.title}</span>
                    <span className="vnext-meri__evidence-step-detail">{step.detail}</span>
                  </span>
                  <span className="vnext-meri__evidence-step-pill">{meta.state}</span>
                </div>
              );
            })}
          </div>
          <div className="vnext-meri__evidence-assumptions">
            <div className="vnext-meri__evidence-assumptions-label">ASSUMPTIONS STATED IN THE ANSWER</div>
            <ul className="vnext-meri__evidence-assumptions-list">
              {assumptions.map((assumption) => (
                <li key={assumption} className="vnext-meri__evidence-assumption">
                  <span className="vnext-meri__evidence-assumption-dot" />
                  <span>{assumption}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="vnext-meri__evidence-disclaimer">
            THIS IS EXECUTION EVIDENCE — PLANS, SOURCES, CHECKS AND OUTCOMES. IT IS NOT MODEL
            REASONING.
          </div>
        </div>
      ) : null}

      {tab === 'ctx' ? (
        <div className="vnext-meri__evidence-tab-body">
          {context.degraded ? (
            <div className="vnext-meri__evidence-degraded">
              <div className="vnext-meri__evidence-degraded-label">CONTEXT DEGRADED</div>
              <div className="vnext-meri__evidence-degraded-text">{context.degraded}</div>
            </div>
          ) : null}
          <div className="vnext-meri__evidence-section-label">INCLUDED · {context.included.length}</div>
          <div className="vnext-meri__evidence-section">
            {context.included.map((item) => (
              <div key={item.name} className="vnext-meri__evidence-ctx-item">
                <div className="vnext-meri__evidence-ctx-item-head">
                  <span className="vnext-meri__evidence-ctx-item-name">{item.name}</span>
                  <span className="vnext-meri__evidence-ctx-item-scope" data-scope={item.scope}>
                    {item.scope}
                  </span>
                  <span className="vnext-meri__evidence-ctx-item-auto">
                    {item.auto ? 'AUTO-RETRIEVED' : 'YOU SELECTED'}
                  </span>
                  <span className="vnext-meri__evidence-ctx-item-type">{item.type}</span>
                </div>
                <div className="vnext-meri__evidence-ctx-item-rationale">{item.rationale}</div>
                <div className="vnext-meri__evidence-ctx-item-meta-row">
                  {item.meta.map((meta) => (
                    <span key={meta} className="vnext-meri__evidence-ctx-item-meta">
                      {meta}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="vnext-meri__evidence-section-label">EXCLUDED · {context.excluded.length}</div>
          <div className="vnext-meri__evidence-section">
            {context.excluded.map((exclusion) => (
              <div key={exclusion.name} className="vnext-meri__evidence-ctx-exclusion">
                <span className={`vnext-meri__evidence-ctx-exclusion-name${exclusion.restricted ? ' is-restricted' : ''}`}>
                  {exclusion.name}
                </span>
                <span className="vnext-meri__evidence-ctx-exclusion-reason" data-tone={exclusion.tone}>
                  {exclusion.reason}
                </span>
              </div>
            ))}
          </div>
          <div className="vnext-meri__evidence-ctx-footer">
            <span className="vnext-meri__evidence-ctx-footer-id">{context.packet}</span>
            <span className="vnext-meri__evidence-ctx-footer-spacer" />
            <button type="button" className="vnext-meri__rail-action-btn" onClick={() => onReviewContext?.()}>
              <MeriIcon name="Sliders02" size={13} />
              Review context
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
