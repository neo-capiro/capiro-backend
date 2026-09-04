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
    <div style={{ marginTop: 26 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontFamily: 'Inter, sans-serif',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '.07em',
            color: '#667085',
          }}
        >
          START WORK
        </span>
        <span style={{ flex: 1, height: 1, background: '#F2F4F7' }} />
        <div role="tablist" aria-label="Start work" style={{ display: 'flex', gap: 4 }}>
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
                  height: 32,
                  padding: '0 12px',
                  borderRadius: 8,
                  background: on ? '#F2F4F7' : '#FFFFFF',
                  border: on ? '1px solid #E4E7EC' : '1px solid transparent',
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '.02em',
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
        role="tabpanel"
        style={{
          marginTop: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(2,minmax(0,1fr))',
          gap: 10,
        }}
      >
        {loading ? (
          <div
            className="vnext-meri__startwork-state"
            style={{ gridColumn: '1 / -1' }}
          >
            {tab === 'SKILLS' ? 'Loading available skills…' : 'Loading saved prompts…'}
          </div>
        ) : null}
        {errored ? (
          <div
            className="vnext-meri__startwork-state is-error"
            style={{ gridColumn: '1 / -1' }}
          >
            {tab === 'SKILLS' ? 'Skills could not be loaded.' : 'Saved prompts could not be loaded.'}
          </div>
        ) : null}
        {!loading && !errored && cards.length === 0 ? (
          <div
            className="vnext-meri__startwork-state"
            style={{ gridColumn: '1 / -1' }}
          >
            <span className="vnext-meri__startwork-empty-title">
              {tab === 'SKILLS' ? 'No skills yet' : 'No saved prompts yet'}
            </span>
            <span className="vnext-meri__startwork-empty-text">
              {tab === 'SKILLS'
                ? 'Skills are created conversationally — ask Meri to turn a routine into one. There is no configuration screen.'
                : 'Save a prompt from a message you liked and it shows up here.'}
            </span>
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
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 7,
              padding: '14px 15px',
              borderRadius: 10,
              background: '#FFFFFF',
              boxShadow:
                hoveredTitle === card.title
                  ? '0 0 0 1px #D0D5DD,0 2px 4px rgba(16,24,40,.04)'
                  : '0 0 0 1px #EAECF0',
              textAlign: 'left',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%' }}>
              <MeriIcon name={card.icon} size={16} color="#475467" />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: '#101828',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {card.title}
              </span>
            </span>
            <span style={{ fontSize: 12.5, lineHeight: '18px', color: '#667085' }}>
              {card.desc}
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 20,
                padding: '0 7px',
                borderRadius: 5,
                background: card.needsClient ? '#FFFAEB' : '#F0F1F7',
                fontFamily: 'Inter, sans-serif',
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '.04em',
                color: card.needsClient ? '#B54708' : '#363F72',
              }}
            >
              {card.needsClient ? 'NEEDS A CLIENT' : card.tag}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
