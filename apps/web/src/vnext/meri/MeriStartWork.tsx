import { useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { meriEffectiveIdentityKey } from '../../components/chat/meri-route-guards.js';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon } from './meri-icons.js';
import { meriStartWorkCards, type MeriStartWorkCard } from './meri-start-work.js';
import { listMeriSavedPrompts } from './meri-vnext-api.js';

/**
 * MeriStartWork — START WORK section on the empty-thread landing: a SKILLS /
 * PROMPTS tabbed card grid. Selecting a card fills an editable intent into the
 * composer; nothing is sent until the user presses Send.
 *
 * Skills come from GET /api/clio/v3/skills. Prompts come from the saved-prompt
 * product. Neither tab may invent fixture cards.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

type StartTab = 'SKILLS' | 'PROMPTS';

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
  const api = useApi();
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const identityKey = meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
  const [tab, setTab] = useState<StartTab>('SKILLS');
  const [hoveredTitle, setHoveredTitle] = useState<string | null>(null);

  const skillsQuery = useQuery({
    queryKey: ['meri-vnext', identityKey, 'skills'],
    queryFn: async () => (await api.get('/api/clio/v3/skills')).data as unknown,
    staleTime: 30_000,
  });
  const promptsQuery = useQuery({
    queryKey: ['meri-vnext', identityKey, 'saved-prompts'],
    queryFn: () => listMeriSavedPrompts(api),
    staleTime: 30_000,
  });

  const selectedClient =
    controller.clients.find((client) => client.id === controller.selectedClientValue) ?? null;
  const catalog = useMemo(
    () =>
      meriStartWorkCards({
        skills: skillsQuery.data,
        prompts: promptsQuery.data,
        clientName: selectedClient?.name ?? null,
      }),
    [promptsQuery.data, selectedClient?.name, skillsQuery.data],
  );
  const cards = tab === 'SKILLS' ? catalog.skills : catalog.prompts;
  const loading = tab === 'SKILLS' ? skillsQuery.isLoading : promptsQuery.isLoading;
  const errored = tab === 'SKILLS' ? skillsQuery.isError : promptsQuery.isError;
  const hasClient = Boolean(controller.selectedClientValue);

  const pick = (card: MeriStartWorkCard) => {
    if (disabled) return;
    if (card.needsClient && !hasClient) {
      toast.success('Pick a client scope first — this one works on a single client.');
      return;
    }
    if (onFillIntent) {
      onFillIntent(card.fill);
    } else {
      window.dispatchEvent(new CustomEvent('meri-fill-draft', { detail: card.fill }));
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
        <span style={{ flex: 1, height: 1, background: '#E8E5DF' }} />
        <div
          role="tablist"
          aria-label="Start work"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            padding: 2,
            borderRadius: 8,
            background: '#FAF9F6',
            border: '1px solid #E8E5DF',
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
                  border: on ? '1px solid #E0DCD4' : '1px solid transparent',
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
        {loading ? (
          <div className="vnext-meri__ctx-empty" style={{ gridColumn: '1 / -1' }}>
            {tab === 'SKILLS' ? 'Loading available skills…' : 'Loading saved prompts…'}
          </div>
        ) : null}
        {errored ? (
          <div className="vnext-meri__ctx-empty" style={{ gridColumn: '1 / -1' }}>
            {tab === 'SKILLS' ? 'Skills could not be loaded.' : 'Saved prompts could not be loaded.'}
          </div>
        ) : null}
        {!loading && !errored && cards.length === 0 ? (
          <div className="vnext-meri__ctx-empty" style={{ gridColumn: '1 / -1' }}>
            {tab === 'SKILLS'
              ? 'No skills are available.'
              : 'No saved prompts yet. Save one from the thread rail.'}
          </div>
        ) : null}
        {cards.map((card) => (
          <button
            type="button"
            key={card.id}
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
              background: hoveredTitle === card.title ? '#FAF9F6' : '#ffffff',
              boxShadow:
                hoveredTitle === card.title
                  ? '0 0 0 1px #E0DCD4'
                  : '0 0 0 1px #E8E5DF,0px 1px 2px rgba(16,24,40,.05)',
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
                background: '#F2F0EB',
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
                      border: '1px solid #FEDF89',
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
