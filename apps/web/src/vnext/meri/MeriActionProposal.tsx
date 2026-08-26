import { useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriActionProposal — governed action card with the ten-state lifecycle
 * (needs → approved → executing → succeeded | retry | terminal | unknown |
 * blocked | dismissed | expired). Pixel-parity port of the prototype's
 * `hasProposal` block (screens K1/K2/L + the screen-Q gallery).
 *
 * BACKEND GAP: the vNext workspace has no action-proposal feed. The card
 * takes a display spec; state transitions and approve/dismiss wiring are the
 * host's job via the action callbacks. Tracked in GAPS.md (Meri vNext —
 * governed action proposals).
 */

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

export type MeriActionProposalState =
  | 'needs'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'retry'
  | 'terminal'
  | 'unknown'
  | 'blocked'
  | 'dismissed'
  | 'expired';

export type MeriActionFlagTone = 'ext' | 'int' | 'rev' | 'irrev';

export interface MeriActionField {
  label: string;
  value: string;
  mono?: boolean;
}

export interface MeriActionFlag {
  tone: MeriActionFlagTone;
  label: string;
}

export type MeriActionButtonKind = 'primary' | 'ghost' | 'danger';

export interface MeriActionButton {
  kind: MeriActionButtonKind;
  label: string;
  onClick?: () => void;
}

export interface MeriActionProposalSpec {
  state: MeriActionProposalState;
  title: string;
  risk: string;
  why: string;
  fields: MeriActionField[];
  body?: string[];
  flags: MeriActionFlag[];
  errorLabel?: string;
  error?: string;
  detailRows: Array<[label: string, value: string]>;
  actions: MeriActionButton[];
}

/** Prototype fixture — screen K1 ("Send email to Jordan Reyes", needs approval). */
export const MERI_PROPOSAL_FIXTURE: MeriActionProposalSpec = {
  state: 'needs',
  title: 'Send email to Jordan Reyes',
  risk: 'HIGH RISK · EXTERNAL',
  why: 'This sends a message to a recipient outside your tenant and cannot be recalled once delivered.',
  fields: [
    { label: 'CLIENT', value: 'Lockheed Martin' },
    { label: 'RECIPIENT', value: 'JORDAN REYES · jreyes@…', mono: true },
    { label: 'CHANNEL', value: 'Gmail · your connected account' },
    { label: 'SUBJECT', value: 'FY27 rotorcraft position after the HAC-D mark' },
  ],
  body: [
    'Jordan — HAC-D marked ITEP at $172.8M overnight, $9.4M below the HASC figure and $5.3M above the request.',
    'Recommendation unchanged: hold the HASC position through conference. In FY25 and FY26 the conference outcome tracked the House appropriations number, so we should plan against $172.8M and argue for the authorised figure.',
    'One action on us: Calvert staff asked for a one-page district-impact summary before Thursday. I will have it to you tomorrow morning.',
  ],
  flags: [
    { tone: 'ext', label: 'LEAVES YOUR TENANT' },
    { tone: 'irrev', label: 'NOT RELIABLY REVERSIBLE' },
    { tone: 'int', label: '1 RECIPIENT · 0 CC' },
  ],
  detailRows: [
    ['POLICY REASON', 'External communication on behalf of a client requires named human approval.'],
    ['POLICY RULE', 'external_send.requires_approval — always, no confidence threshold.'],
    ['POLICY PACK', 'capiro-governance v4.2'],
    ['PROPOSAL EXPIRES', 'Aug 16, 2026 · 11:59 PM'],
    ['ATTEMPTS', '0'],
    ['APPROVAL HISTORY', 'None. This is the first proposal for this artifact.'],
    ['CLAIMS IN BODY', '4 figures · all resolve to cited locators'],
  ],
  actions: [
    { kind: 'ghost', label: 'Dismiss' },
    { kind: 'ghost', label: 'Edit proposal' },
    { kind: 'primary', label: 'Review & approve' },
  ],
};

const LIFE: Record<
  MeriActionProposalState,
  { status: string; icon: MeriIconName; headBg: string; ring: string; fg: string }
> = {
  needs: { status: 'NEEDS YOUR APPROVAL', icon: 'Shield01', headBg: '#FFFAEB', ring: '#FEDF89', fg: '#B54708' },
  approved: { status: 'APPROVED · NOT YET EXECUTED', icon: 'CheckCircle', headBg: '#F2F4F7', ring: '#D0D5DD', fg: '#344054' },
  executing: { status: 'EXECUTING', icon: 'Loading01', headBg: '#F2F4F7', ring: '#D0D5DD', fg: '#101828' },
  succeeded: { status: 'SUCCEEDED', icon: 'CheckCircle', headBg: '#ECFDF3', ring: '#ABEFC6', fg: '#027A48' },
  retry: { status: 'FAILED · RETRY AVAILABLE', icon: 'RefreshCcw02', headBg: '#FEF3F2', ring: '#FECDCA', fg: '#B42318' },
  terminal: { status: 'FAILED · NOT RETRYABLE', icon: 'XCircle', headBg: '#FEF3F2', ring: '#FECDCA', fg: '#B42318' },
  unknown: { status: 'OUTCOME UNKNOWN', icon: 'HelpCircle', headBg: '#FFFAEB', ring: '#FEDF89', fg: '#B54708' },
  blocked: { status: 'BLOCKED BY POLICY', icon: 'Lock01', headBg: '#FEF3F2', ring: '#FECDCA', fg: '#B42318' },
  dismissed: { status: 'DISMISSED', icon: 'SlashCircle01', headBg: '#F9FAFB', ring: '#EAECF0', fg: '#667085' },
  expired: { status: 'EXPIRED', icon: 'Hourglass03', headBg: '#F9FAFB', ring: '#EAECF0', fg: '#667085' },
};

const FLAG: Record<MeriActionFlagTone, { bg: string; ring: string; fg: string; dot: string }> = {
  ext: { bg: '#FFFAEB', ring: '#FEDF89', fg: '#B54708', dot: '#F79009' },
  int: { bg: '#F9FAFB', ring: '#EAECF0', fg: '#344054', dot: '#667085' },
  rev: { bg: '#ECFDF3', ring: '#ABEFC6', fg: '#027A48', dot: '#12B76A' },
  irrev: { bg: '#FEF3F2', ring: '#FECDCA', fg: '#B42318', dot: '#F04438' },
};

const BTN: Record<MeriActionButtonKind, { bg: string; shadow?: string; border?: string; fg: string; pad: string }> = {
  primary: {
    bg: 'linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)',
    shadow: 'inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(16,24,40,.12)',
    fg: '#ffffff',
    pad: '15px',
  },
  ghost: { bg: '#ffffff', border: '1px solid #D0D5DD', fg: '#344054', pad: '13px' },
  danger: { bg: '#ffffff', border: '1px solid #FECDCA', fg: '#B42318', pad: '13px' },
};

interface MeriActionProposalProps {
  /** Reserved for wiring to live proposals; fixture renders when absent. */
  controller?: MeriChatController;
  proposal?: MeriActionProposalSpec;
  /** Fired when any footer action without its own onClick is pressed. */
  onAction?: (label: string, proposal: MeriActionProposalSpec) => void;
}

export function MeriActionProposal({
  proposal = MERI_PROPOSAL_FIXTURE,
  onAction,
}: MeriActionProposalProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const life = LIFE[proposal.state];

  return (
    <div
      style={{
        margin: '0 18px 16px',
        borderRadius: 11,
        background: '#ffffff',
        border: `1px solid ${life.ring}`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '12px 15px',
          background: life.headBg,
        }}
      >
        <MeriIcon name={life.icon} size={15} color={life.fg} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: MONO,
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '.09em',
            color: life.fg,
          }}
        >
          {life.status}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 20,
            padding: '0 7px',
            borderRadius: 5,
            background: '#ffffff',
            border: `1px solid ${life.ring}`,
            fontFamily: MONO,
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: '.08em',
            color: life.fg,
          }}
        >
          {proposal.risk}
        </span>
      </div>

      <div style={{ padding: 15 }}>
        <div style={{ fontSize: 15, lineHeight: '22px', fontWeight: 600, color: '#101828' }}>
          {proposal.title}
        </div>
        <div style={{ marginTop: 4, fontSize: 13, lineHeight: '19px', color: '#667085' }}>
          {proposal.why}
        </div>

        <div
          style={{
            marginTop: 13,
            display: 'grid',
            gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
            gap: 1,
            background: '#EAECF0',
            borderRadius: 9,
            overflow: 'hidden',
            border: '1px solid #EAECF0',
          }}
        >
          {proposal.fields.map((field) => (
            <div key={field.label} style={{ padding: '10px 12px', background: '#ffffff' }}>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.09em',
                  color: '#667085',
                }}
              >
                {field.label}
              </div>
              <div
                style={{
                  marginTop: 5,
                  fontFamily: field.mono ? MONO : 'inherit',
                  fontSize: 13,
                  lineHeight: '19px',
                  fontWeight: 500,
                  color: '#101828',
                }}
              >
                {field.value}
              </div>
            </div>
          ))}
        </div>

        {proposal.body && proposal.body.length > 0 ? (
          <div
            style={{
              marginTop: 12,
              padding: '13px 14px',
              borderRadius: 9,
              background: '#F9FAFB',
              border: '1px solid #EAECF0',
              borderLeft: '2px solid #101828',
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '.09em',
                color: '#667085',
              }}
            >
              MESSAGE PREVIEW
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {proposal.body.map((line, index) => (
                <div key={index} style={{ fontSize: 13, lineHeight: '20px', color: '#344054' }}>
                  {line}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 13 }}>
          {proposal.flags.map((flag) => {
            const tone = FLAG[flag.tone];
            return (
              <span
                key={flag.label}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 24,
                  padding: '0 9px',
                  borderRadius: 6,
                  background: tone.bg,
                  border: `1px solid ${tone.ring}`,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: 9999, background: tone.dot }} />
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9,
                    fontWeight: 500,
                    letterSpacing: '.08em',
                    color: tone.fg,
                  }}
                >
                  {flag.label}
                </span>
              </span>
            );
          })}
        </div>

        {proposal.error ? (
          <div
            style={{
              marginTop: 12,
              padding: '11px 13px',
              borderRadius: 9,
              background: '#FEF3F2',
              border: '1px solid #FECDCA',
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '.09em',
                color: '#B42318',
              }}
            >
              {proposal.errorLabel ?? 'FAILURE DETAIL'}
            </div>
            <div style={{ marginTop: 6, fontSize: 13, lineHeight: '19px', color: '#344054' }}>
              {proposal.error}
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 9,
            marginTop: 15,
            paddingTop: 14,
            borderTop: '1px solid #F2F4F7',
          }}
        >
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '.08em',
              color: '#667085',
            }}
          >
            <MeriIcon name="ChevronDown" size={13} />
            {detailsOpen ? 'HIDE POLICY AND AUDIT DETAIL' : 'POLICY AND AUDIT DETAIL'}
          </button>
          <span style={{ flex: 1 }} />
          {proposal.actions.map((action) => {
            const btn = BTN[action.kind];
            return (
              <button
                type="button"
                key={action.label}
                onClick={() => (action.onClick ? action.onClick() : onAction?.(action.label, proposal))}
                style={{
                  height: 36,
                  padding: `0 ${btn.pad}`,
                  borderRadius: 8,
                  background: btn.bg,
                  border: btn.border,
                  boxShadow: btn.shadow,
                  fontSize: 13,
                  fontWeight: 600,
                  color: btn.fg,
                }}
              >
                {action.label}
              </button>
            );
          })}
        </div>

        {detailsOpen ? (
          <div
            style={{
              marginTop: 13,
              padding: '13px 14px',
              borderRadius: 9,
              background: '#F9FAFB',
              border: '1px solid #EAECF0',
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '.09em',
                color: '#667085',
              }}
            >
              GOVERNANCE DETAIL
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {proposal.detailRows.map(([label, value]) => (
                <div key={label} style={{ display: 'flex', gap: 12 }}>
                  <span
                    style={{
                      flex: '0 0 150px',
                      fontFamily: MONO,
                      fontSize: 9.5,
                      fontWeight: 500,
                      letterSpacing: '.07em',
                      color: '#98A2B3',
                    }}
                  >
                    {label}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '18px', color: '#344054' }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
