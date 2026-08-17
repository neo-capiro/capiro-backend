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
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

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

/* ── Tone tables (from the prototype's VSTAT / CLAIM / STEP / EXC) ───────── */

const VSTAT: Record<MeriEvidenceStatTone, { bg: string; ring: string; fg: string }> = {
  n: { bg: '#ffffff', ring: '#EAECF0', fg: '#344054' },
  g: { bg: '#ECFDF3', ring: '#ABEFC6', fg: '#027A48' },
  w: { bg: '#FFFAEB', ring: '#FEDF89', fg: '#B54708' },
  b: { bg: '#FEF3F2', ring: '#FECDCA', fg: '#B42318' },
};

const CLAIM_STYLE: Record<
  MeriClaimState,
  { state: string; icon: MeriIconName; dotBg: string; dotFg: string; fg: string }
> = {
  verified: { state: 'VERIFIED · TIED TO A CITED LOCATOR', icon: 'Check', dotBg: '#101828', dotFg: '#ffffff', fg: '#027A48' },
  inference: { state: 'INFERENCE · DERIVED, NOT QUOTED', icon: 'Diamond01', dotBg: '#F2F4F7', dotFg: '#344054', fg: '#344054' },
  unsupported: { state: 'UNSUPPORTED · NO EVIDENCE FOUND', icon: 'AlertTriangle', dotBg: '#FFFAEB', dotFg: '#B54708', fg: '#B54708' },
  conflict: { state: 'SOURCES DISAGREE', icon: 'SwitchVertical01', dotBg: '#FFFAEB', dotFg: '#B54708', fg: '#B54708' },
  low: { state: 'LOW CONFIDENCE · SINGLE WEAK SOURCE', icon: 'HelpCircle', dotBg: '#F2F4F7', dotFg: '#667085', fg: '#667085' },
};

const STEP_STYLE: Record<
  MeriWorkStepState,
  { state: string; icon: MeriIconName; dotBg: string; dotFg: string; pillBg: string; pillFg: string; ring: string }
> = {
  done: { state: 'DONE', icon: 'Check', dotBg: '#101828', dotFg: '#ffffff', pillBg: '#F2F4F7', pillFg: '#344054', ring: 'inset 0 0 0 1px #EAECF0' },
  running: { state: 'RUNNING', icon: 'Loading01', dotBg: '#101828', dotFg: '#ffffff', pillBg: '#F2F4F7', pillFg: '#101828', ring: 'inset 0 0 0 1px #D0D5DD,0 0 0 3px #F2F4F7' },
  queued: { state: 'QUEUED', icon: 'Clock', dotBg: '#F2F4F7', dotFg: '#98A2B3', pillBg: '#F9FAFB', pillFg: '#667085', ring: 'inset 0 0 0 1px #EAECF0' },
  failed: { state: 'FAILED', icon: 'XClose', dotBg: '#FEF3F2', dotFg: '#B42318', pillBg: '#FEF3F2', pillFg: '#B42318', ring: 'inset 0 0 0 1px #FECDCA' },
  skipped: { state: 'SKIPPED', icon: 'SlashCircle01', dotBg: '#F2F4F7', dotFg: '#98A2B3', pillBg: '#F9FAFB', pillFg: '#667085', ring: 'inset 0 0 0 1px #EAECF0' },
};

const EXC_STYLE: Record<MeriContextExclusionTone, { bg: string; fg: string }> = {
  n: { bg: '#F2F4F7', fg: '#344054' },
  w: { bg: '#FFFAEB', fg: '#B54708' },
  b: { bg: '#FEF3F2', fg: '#B42318' },
};

const SCOPE_STYLE: Record<MeriContextItem['scope'], { bg: string; fg: string }> = {
  FIRM: { bg: '#F2F4F7', fg: '#344054' },
  CLIENT: { bg: '#ECFDF3', fg: '#027A48' },
  PERSONAL: { bg: '#FFFAEB', fg: '#B54708' },
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
  sources = MERI_EVIDENCE_SOURCES,
  verifyStats = MERI_VERIFY_STATS,
  claims = MERI_CLAIMS,
  plan = MERI_WORK_PLAN,
  workStats = MERI_WORK_STATS,
  steps = MERI_WORK_STEPS,
  assumptions = MERI_ASSUMPTIONS,
  context = MERI_CONTEXT_PACKET,
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
    <div
      style={{
        borderTop: '1px solid #EAECF0',
        background: '#F9FAFB',
        animation: 'vnext-meri-rise .14s ease',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '11px 18px',
          borderBottom: '1px solid #EAECF0',
          flexWrap: 'wrap',
        }}
        role="tablist"
        aria-label="Evidence"
      >
        {tabs.map((t) => {
          const on = tab === t.key;
          return (
            <button
              type="button"
              key={t.key}
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.key)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                height: 28,
                padding: '0 11px',
                borderRadius: 7,
                background: on ? '#ffffff' : 'transparent',
                boxShadow: on ? 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)' : 'none',
              }}
            >
              <MeriIcon name={t.icon} size={13} color={on ? '#101828' : '#667085'} />
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9.5,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: on ? '#101828' : '#667085',
                }}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </div>

      {tab === 'sources' ? (
        <div style={{ padding: '14px 18px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sources.map((source, index) => (
            <button
              type="button"
              key={`${source.locator}-${index}`}
              onClick={() => onOpenSource?.(source, index)}
              style={{
                display: 'flex',
                gap: 11,
                padding: '12px 13px',
                borderRadius: 9,
                background: '#ffffff',
                boxShadow: 'inset 0 0 0 1px #EAECF0',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: '#F2F4F7',
                }}
              >
                <MeriIcon name={source.icon} size={13} color="#101828" />
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: '#667085' }}>
                    {source.provider}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: '#98A2B3' }}>
                    {source.date}
                  </span>
                </span>
                <span style={{ fontSize: 13, lineHeight: '19px', fontWeight: 600, color: '#101828' }}>
                  [{index + 1}] {source.title}
                </span>
                <span style={{ fontSize: 12.5, lineHeight: '18px', color: '#475467' }}>
                  {source.snippet}
                </span>
              </span>
              <span
                style={{
                  flex: '0 0 auto',
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.07em',
                  color: '#667085',
                  textAlign: 'right',
                }}
              >
                {source.locator}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {tab === 'verify' ? (
        <div style={{ padding: '14px 18px 16px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
            {verifyStats.map((stat) => {
              const tone = VSTAT[stat.tone];
              return (
                <span
                  key={stat.label}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 7,
                    background: tone.bg,
                    boxShadow: `inset 0 0 0 1px ${tone.ring}`,
                    fontFamily: MONO,
                    fontSize: 9.5,
                    fontWeight: 500,
                    letterSpacing: '.08em',
                    color: tone.fg,
                  }}
                >
                  {stat.label}
                </span>
              );
            })}
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {claims.map((claim, index) => {
              const style = CLAIM_STYLE[claim.state];
              return (
                <div
                  key={`${claim.claim}-${index}`}
                  style={{
                    display: 'flex',
                    gap: 11,
                    padding: '12px 13px',
                    borderRadius: 9,
                    background: '#ffffff',
                    boxShadow: 'inset 0 0 0 1px #EAECF0',
                  }}
                >
                  <span
                    style={{
                      flex: '0 0 auto',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 20,
                      height: 20,
                      marginTop: 1,
                      borderRadius: 9999,
                      background: style.dotBg,
                    }}
                  >
                    <MeriIcon name={style.icon} size={11} color={style.dotFg} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 13, lineHeight: '19px', color: '#344054' }}>{claim.claim}</span>
                    <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: style.fg }}>
                      {style.state}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === 'work' ? (
        <div style={{ padding: '14px 18px 16px' }}>
          <div style={{ padding: '12px 13px', borderRadius: 9, background: '#ffffff', boxShadow: 'inset 0 0 0 1px #EAECF0' }}>
            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.09em', color: '#667085' }}>
              PLAN
            </div>
            <div style={{ marginTop: 7, fontSize: 13, lineHeight: '20px', color: '#344054' }}>{plan}</div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 12 }}>
            {workStats.map((stat) => (
              <span
                key={stat}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 7,
                  background: '#ffffff',
                  boxShadow: 'inset 0 0 0 1px #EAECF0',
                  fontFamily: MONO,
                  fontSize: 9.5,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: '#344054',
                }}
              >
                {stat}
              </span>
            ))}
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {steps.map((step, index) => {
              const style = STEP_STYLE[step.state];
              return (
                <div
                  key={`${step.title}-${index}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 11,
                    padding: '11px 13px',
                    borderRadius: 9,
                    background: '#ffffff',
                    boxShadow: style.ring,
                  }}
                >
                  <span
                    style={{
                      flex: '0 0 auto',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 20,
                      height: 20,
                      marginTop: 1,
                      borderRadius: 9999,
                      background: style.dotBg,
                    }}
                  >
                    <MeriIcon name={style.icon} size={11} color={style.dotFg} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 13, lineHeight: '19px', fontWeight: 500, color: '#101828' }}>
                      {step.title}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.05em', color: '#667085' }}>
                      {step.detail}
                    </span>
                  </span>
                  <span
                    style={{
                      flex: '0 0 auto',
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 20,
                      padding: '0 7px',
                      borderRadius: 5,
                      background: style.pillBg,
                      fontFamily: MONO,
                      fontSize: 9,
                      fontWeight: 500,
                      letterSpacing: '.08em',
                      color: style.pillFg,
                    }}
                  >
                    {style.state}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 12, padding: '11px 13px', borderRadius: 9, background: '#ffffff', boxShadow: 'inset 0 0 0 1px #EAECF0' }}>
            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.09em', color: '#667085' }}>
              ASSUMPTIONS STATED IN THE ANSWER
            </div>
            <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {assumptions.map((assumption) => (
                <li key={assumption} style={{ display: 'flex', gap: 9, fontSize: 12.5, lineHeight: '19px', color: '#344054' }}>
                  <span style={{ flex: '0 0 auto', width: 5, height: 5, marginTop: 7, borderRadius: 9999, background: '#101828' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>{assumption}</span>
                </li>
              ))}
            </ul>
          </div>
          <div
            style={{
              marginTop: 11,
              fontFamily: MONO,
              fontSize: 9,
              fontWeight: 500,
              lineHeight: '15px',
              letterSpacing: '.08em',
              color: '#98A2B3',
            }}
          >
            THIS IS EXECUTION EVIDENCE — PLANS, SOURCES, CHECKS AND OUTCOMES. IT IS NOT MODEL
            REASONING.
          </div>
        </div>
      ) : null}

      {tab === 'ctx' ? (
        <div style={{ padding: '14px 18px 16px' }}>
          {context.degraded ? (
            <div style={{ marginBottom: 12, padding: '11px 13px', borderRadius: 9, background: '#FFFAEB', boxShadow: 'inset 0 0 0 1px #FEDF89' }}>
              <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.09em', color: '#B54708' }}>
                CONTEXT DEGRADED
              </div>
              <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: '19px', color: '#344054' }}>
                {context.degraded}
              </div>
            </div>
          ) : null}
          <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.09em', color: '#667085' }}>
            INCLUDED · {context.included.length}
          </div>
          <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {context.included.map((item) => {
              const scope = SCOPE_STYLE[item.scope];
              return (
                <div
                  key={item.name}
                  style={{ padding: '12px 13px', borderRadius: 9, background: '#ffffff', boxShadow: 'inset 0 0 0 1px #EAECF0' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, lineHeight: '19px', fontWeight: 600, color: '#101828' }}>
                      {item.name}
                    </span>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 19,
                        padding: '0 6px',
                        borderRadius: 4,
                        background: scope.bg,
                        fontFamily: MONO,
                        fontSize: 8.5,
                        fontWeight: 500,
                        letterSpacing: '.07em',
                        color: scope.fg,
                      }}
                    >
                      {item.scope}
                    </span>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 19,
                        padding: '0 6px',
                        borderRadius: 4,
                        background: '#F2F4F7',
                        fontFamily: MONO,
                        fontSize: 8.5,
                        fontWeight: 500,
                        letterSpacing: '.07em',
                        color: '#344054',
                      }}
                    >
                      {item.auto ? 'AUTO-RETRIEVED' : 'YOU SELECTED'}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '.06em', color: '#98A2B3' }}>
                      {item.type}
                    </span>
                  </div>
                  <div style={{ marginTop: 7, fontSize: 12.5, lineHeight: '18px', color: '#475467' }}>
                    {item.rationale}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginTop: 8 }}>
                    {item.meta.map((meta) => (
                      <span
                        key={meta}
                        style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.07em', color: '#667085' }}
                      >
                        {meta}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 14, fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.09em', color: '#667085' }}>
            EXCLUDED · {context.excluded.length}
          </div>
          <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {context.excluded.map((exclusion) => {
              const tone = EXC_STYLE[exclusion.tone];
              return (
                <div
                  key={exclusion.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 13px',
                    borderRadius: 9,
                    background: '#ffffff',
                    boxShadow: 'inset 0 0 0 1px #EAECF0',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      lineHeight: '18px',
                      color: exclusion.restricted ? '#98A2B3' : '#344054',
                    }}
                  >
                    {exclusion.name}
                  </span>
                  <span
                    style={{
                      flex: '0 0 auto',
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 20,
                      padding: '0 7px',
                      borderRadius: 5,
                      background: tone.bg,
                      fontFamily: MONO,
                      fontSize: 8.5,
                      fontWeight: 500,
                      letterSpacing: '.07em',
                      color: tone.fg,
                    }}
                  >
                    {exclusion.reason}
                  </span>
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid #EAECF0',
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.07em', color: '#98A2B3' }}>
              {context.packet}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => onReviewContext?.()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                height: 32,
                padding: '0 12px',
                borderRadius: 8,
                background: '#ffffff',
                boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
              }}
            >
              <MeriIcon name="Sliders02" size={13} color="#344054" />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#344054' }}>Review context</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
