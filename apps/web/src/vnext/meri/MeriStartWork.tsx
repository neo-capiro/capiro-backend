import { useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriStartWork — START WORK section on the empty-thread landing: a SKILLS /
 * PROMPTS tabbed card grid. Selecting a card fills an editable intent into the
 * composer; nothing is sent until the user presses Send.
 *
 * Pixel-parity port of the prototype's `startCards` section. Skills route
 * through the composer intent (there is no dedicated skills endpoint), which
 * is the standing gap for the skills runtime.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

type StartTab = 'SKILLS' | 'PROMPTS';

interface StartCard {
  icon: MeriIconName;
  title: string;
  desc: string;
  tag: string;
  needsClient: boolean;
  fill: string;
}

const SKILL_CARDS: StartCard[] = [
  {
    icon: 'Building07',
    title: 'Research a company',
    desc: 'Federal footprint, contracts, programs, relationships and where we intersect.',
    tag: 'ANY ORGANISATION',
    needsClient: false,
    fill: 'Research a company: ',
  },
  {
    icon: 'Users02',
    title: 'Relationship brief',
    desc: 'Who a person is, our history with them, and what to raise next.',
    tag: 'PERSON OR ORGANISATION',
    needsClient: false,
    fill: 'Build a relationship brief for ',
  },
  {
    icon: 'ClockFastForward',
    title: 'Client changes',
    desc: 'Exactly what moved for one client, and what did not.',
    tag: 'ONE CLIENT',
    needsClient: true,
    fill: 'What changed for ',
  },
  {
    icon: 'Grid01',
    title: 'Portfolio changes',
    desc: 'Material changes across every client, ranked by exposure.',
    tag: 'ALL CLIENTS',
    needsClient: false,
    fill: 'Summarise portfolio changes since Friday, ranked by client exposure.',
  },
  {
    icon: 'Dataflow03',
    title: 'Portfolio overlap',
    desc: 'Where one outside organisation touches several of our clients.',
    tag: 'ALL CLIENTS',
    needsClient: false,
    fill: 'Show where Anduril overlaps with our portfolio.',
  },
  {
    icon: 'File05',
    title: 'Client-ready deliverable',
    desc: 'A memo, brief, target list or deck built from cited work.',
    tag: 'ARTIFACT',
    needsClient: true,
    fill: 'Draft a client-ready memo on ',
  },
];

const PROMPT_CARDS: StartCard[] = [
  {
    icon: 'Grid01',
    title: 'Portfolio changes since Friday',
    desc: 'Ranked by client exposure, with coverage stated.',
    tag: 'PORTFOLIO · ALL CLIENTS',
    needsClient: false,
    fill: 'Summarise portfolio changes since Friday, ranked by client exposure.',
  },
  {
    icon: 'Bank',
    title: 'Prepare me for the HAC-D markup',
    desc: 'Members to watch, likely questions, our position.',
    tag: 'HEARING · APPROPRIATIONS',
    needsClient: false,
    fill: 'Prepare me for the HAC-D markup: members to watch, likely questions, our position.',
  },
  {
    icon: 'Mail01',
    title: 'Draft this week’s client update',
    desc: 'From cited changes, in the client’s preferred format.',
    tag: 'DELIVERABLE',
    needsClient: true,
    fill: 'Draft this week’s client update from the cited changes.',
  },
  {
    icon: 'Coins01',
    title: 'FY27 budget exposure',
    desc: 'Where our lines sit across request, authorization and approps.',
    tag: 'BUDGET · FY27',
    needsClient: false,
    fill: 'Where does our FY27 budget exposure sit across request, authorization and appropriations?',
  },
  {
    icon: 'ClockRewind',
    title: 'Prior-cycle patterns',
    desc: 'How this account behaved in the last three cycles.',
    tag: 'HISTORY',
    needsClient: false,
    fill: 'How has this account behaved across the last three cycles?',
  },
  {
    icon: 'Scales02',
    title: 'Red-team my position',
    desc: 'The strongest case against what we are arguing.',
    tag: 'RED TEAM',
    needsClient: false,
    fill: 'Red-team our position: what is the strongest case against it?',
  },
];

interface MeriStartWorkProps {
  controller: MeriChatController;
  /**
   * Called with the card's intent text. The host wires this to the composer's
   * draft state so the intent lands editable — never auto-sent. When omitted,
   * a toast explains the intent instead (prototype behaviour without a wired
   * composer).
   */
  onFillIntent?: (text: string) => void;
  disabled?: boolean;
}

export function MeriStartWork({ controller, onFillIntent, disabled = false }: MeriStartWorkProps) {
  const toast = useCapiroToast();
  const [tab, setTab] = useState<StartTab>('SKILLS');
  const [hoveredTitle, setHoveredTitle] = useState<string | null>(null);

  const cards = tab === 'SKILLS' ? SKILL_CARDS : PROMPT_CARDS;
  const hasClient = Boolean(controller.selectedClientValue);

  const pick = (card: StartCard) => {
    if (disabled) return;
    if (card.needsClient && !hasClient) {
      toast.success('Pick a client scope first — this one works on a single client.');
      return;
    }
    if (onFillIntent) {
      onFillIntent(card.fill);
    } else {
      toast.success('Intent filled in the composer — press Send when ready.');
    }
  };

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '.1em',
            color: '#667085',
          }}
        >
          START WORK
        </span>
        <span style={{ flex: 1, height: 1, background: '#EAECF0' }} />
        <div
          role="tablist"
          aria-label="Start work"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            padding: 2,
            borderRadius: 8,
            background: '#F9FAFB',
            boxShadow: 'inset 0 0 0 1px #EAECF0',
          }}
        >
          {(['SKILLS', 'PROMPTS'] as StartTab[]).map((label) => {
            const on = tab === label;
            return (
              <button
                type="button"
                key={label}
                role="tab"
                aria-selected={on}
                onClick={() => setTab(label)}
                style={{
                  height: 24,
                  padding: '0 10px',
                  borderRadius: 6,
                  background: on ? '#ffffff' : 'transparent',
                  boxShadow: on ? 'inset 0 0 0 1px #D0D5DD' : 'none',
                  fontFamily: MONO,
                  fontSize: 9.5,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: on ? '#101828' : '#667085',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div
        style={{
          marginTop: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
          gap: 10,
        }}
      >
        {cards.map((card) => (
          <button
            type="button"
            key={card.title}
            disabled={disabled}
            onClick={() => pick(card)}
            onMouseEnter={() => setHoveredTitle(card.title)}
            onMouseLeave={() => setHoveredTitle(null)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 11,
              padding: 14,
              borderRadius: 11,
              background: hoveredTitle === card.title ? '#F9FAFB' : '#ffffff',
              boxShadow:
                hoveredTitle === card.title
                  ? '0 0 0 1px #D0D5DD'
                  : '0 0 0 1px #EAECF0,0px 1px 2px rgba(16,24,40,.05)',
              textAlign: 'left',
            }}
          >
            <span
              style={{
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 8,
                background: '#F2F4F7',
              }}
            >
              <MeriIcon name={card.icon} size={14} color="#101828" />
            </span>
            <span
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}
            >
              <span
                style={{ fontSize: 13.5, lineHeight: '19px', fontWeight: 600, color: '#101828' }}
              >
                {card.title}
              </span>
              <span style={{ fontSize: 12.5, lineHeight: '18px', color: '#475467' }}>
                {card.desc}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 2 }}>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9,
                    fontWeight: 500,
                    letterSpacing: '.08em',
                    color: '#667085',
                  }}
                >
                  {card.tag}
                </span>
                {card.needsClient ? (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      height: 18,
                      padding: '0 6px',
                      borderRadius: 4,
                      background: '#FFFAEB',
                      boxShadow: 'inset 0 0 0 1px #FEDF89',
                      fontFamily: MONO,
                      fontSize: 8.5,
                      fontWeight: 500,
                      letterSpacing: '.07em',
                      color: '#B54708',
                    }}
                  >
                    NEEDS A CLIENT
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          fontFamily: MONO,
          fontSize: 9.5,
          fontWeight: 500,
          letterSpacing: '.08em',
          color: '#98A2B3',
        }}
      >
        SELECTING ONE FILLS AN EDITABLE INTENT IN THE COMPOSER · NOTHING IS SENT UNTIL YOU PRESS
        SEND
      </div>
    </div>
  );
}
