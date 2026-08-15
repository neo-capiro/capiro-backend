import { useEffect, useRef, useState } from 'react';
import type { MeResponse } from '../../lib/me.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { IdentityMark, identityInitials } from '../components/identity/index.js';
import { MeriIcon } from './meri-icons.js';
import { MERI_LOGO_SRC } from './meri-presentation.js';
import type { MeriWindowChrome } from './meri-prefs.js';

interface VNextMeriTopBarProps {
  controller: MeriChatController;
  me: MeResponse | undefined;
  windowChrome: MeriWindowChrome;
  onNewChat: () => void;
  onSearch: () => void;
  onDock: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

const PRO_TIPS = [
  {
    n: '01',
    title: 'Tell Meri to remember things',
    body: 'Say it plainly in the thread — “remember that this principal prefers one-page briefs” — and Meri proposes it as institutional memory. You approve it before it sticks, and future answers for that client can use it.',
    quote: '"Remember: we never cite draft RFP language with clients."',
  },
  {
    n: '02',
    title: 'Turn a routine into a skill',
    body: 'Describe a workflow you repeat, in your own words, and Meri can save it as a named skill you can call again. No server configuration belongs in this workspace.',
    quote:
      '"Create a skill called Monday Brief: for each client, list what moved last week, what needs a decision, and the sources."',
    then: 'THEN JUST SAY: RUN MONDAY BRIEF',
  },
];

export function VNextMeriTopBar({
  controller,
  me,
  windowChrome,
  onNewChat,
  onSearch,
  onDock,
  onToggleMaximize,
  onClose,
}: VNextMeriTopBarProps) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const { clients, selectedClientValue, changeSessionClient } = controller;
  const selectedClient = clients.find((client) => client.id === selectedClientValue) ?? null;
  const scopeLabel = selectedClient ? selectedClient.name.toUpperCase() : 'ALL CLIENTS';

  const firstName = me?.user.firstName?.trim() ?? '';
  const lastName = me?.user.lastName?.trim() ?? '';
  const fullName = `${firstName} ${lastName}`.trim() || me?.user.email?.split('@')[0] || 'User';
  const initials = identityInitials(fullName);

  useEffect(() => {
    if (!scopeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!scopeRef.current?.contains(event.target as Node)) setScopeOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [scopeOpen]);

  useEffect(() => {
    if (!tipOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!tipRef.current?.contains(event.target as Node)) setTipOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [tipOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTipOpen(false);
        setScopeOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <header className="vnext-meri__topbar">
      <div className="vnext-meri__brand">
        <img
          className="vnext-meri__brand-mark"
          src={MERI_LOGO_SRC}
          alt="Meri"
          height={26}
        />
        <span className="vnext-meri__brand-divider" />
        <span className="vnext-meri__brand-workspace">
          <MeriIcon name="LayoutAlt01" size={16} color="#98A2B3" />
          <span className="vnext-meri__brand-label">Undocked Workspace</span>
        </span>
      </div>

      <div className="vnext-meri__scope" ref={scopeRef}>
        <button
          type="button"
          className="vnext-meri__scope-trigger"
          disabled={controller.isStreaming}
          onClick={() => setScopeOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={scopeOpen}
        >
          <MeriIcon name="Building01" size={14} color="#101828" />
          <span className="vnext-meri__scope-label">{scopeLabel}</span>
          <MeriIcon name="ChevronDown" size={14} color="#98A2B3" />
        </button>
        {scopeOpen ? (
          <div className="vnext-meri__scope-menu" role="menu" aria-label="Conversation scope">
            <div className="vnext-meri__scope-menu-eyebrow">CONVERSATION SCOPE</div>
            {clients.map((client) => (
              <button
                type="button"
                role="menuitem"
                key={client.id}
                className={`vnext-meri__scope-menu-item${
                  client.id === selectedClientValue ? ' is-selected' : ''
                }`}
                onClick={() => {
                  setScopeOpen(false);
                  void changeSessionClient(client.id);
                }}
              >
                <span className="vnext-meri__scope-menu-item-label">{client.name}</span>
                <span className="vnext-meri__scope-menu-item-meta">CLIENT</span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className={`vnext-meri__scope-menu-item${
                !selectedClientValue ? ' is-selected' : ''
              }`}
              onClick={() => {
                setScopeOpen(false);
                void changeSessionClient('');
              }}
            >
              <span className="vnext-meri__scope-menu-item-label">All clients</span>
              <span className="vnext-meri__scope-menu-item-meta">
                PORTFOLIO · {clients.length} CLIENTS
              </span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="vnext-meri__topbar-actions">
        <button
          type="button"
          className="vnext-meri__icon-btn"
          title="Search threads — ⌘K"
          aria-label="Search threads"
          onClick={onSearch}
        >
          <MeriIcon name="SearchLg" size={17} color="#475467" />
        </button>
        <button
          type="button"
          className="vnext-meri__icon-btn"
          title="New chat"
          aria-label="Start a new chat"
          onClick={onNewChat}
        >
          <MeriIcon name="Plus" size={17} color="#475467" />
        </button>
        <button
          type="button"
          className="vnext-meri__icon-btn"
          title="Meri help"
          aria-label="Open Meri help"
          onClick={() => setTipOpen(true)}
        >
          <MeriIcon name="HelpCircle" size={17} color="#475467" />
        </button>

        <span className="vnext-meri__protip" ref={tipRef}>
          <button
            type="button"
            className={`vnext-meri__protip-trigger${tipOpen ? ' is-open' : ''}`}
            onClick={() => setTipOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={tipOpen}
          >
            <MeriIcon name="Lightbulb02" size={15} />
            PRO TIP
          </button>
          {tipOpen ? (
            <div
              className="vnext-meri__protip-panel"
              role="dialog"
              aria-label="Get more out of Meri"
            >
              <div className="vnext-meri__protip-header">
                <span className="vnext-meri__protip-title">GET MORE OUT OF MERI</span>
                <button
                  type="button"
                  className="vnext-meri__protip-close"
                  onClick={() => setTipOpen(false)}
                >
                  CLOSE ⎋
                </button>
              </div>
              <div className="vnext-meri__protip-body">
                {PRO_TIPS.map((tip) => (
                  <div key={tip.n} className="vnext-meri__protip-item">
                    <div className="vnext-meri__protip-item-head">
                      <span className="vnext-meri__protip-item-num">{tip.n}</span>
                      <span className="vnext-meri__protip-item-title">{tip.title}</span>
                    </div>
                    <div className="vnext-meri__protip-item-body">{tip.body}</div>
                    <div className="vnext-meri__protip-item-quote">{tip.quote}</div>
                    {tip.then ? (
                      <div className="vnext-meri__protip-item-then">{tip.then}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </span>

        <span className="vnext-meri__avatar" aria-label={fullName}>
          <IdentityMark
            kind="person"
            size="sm"
            name={fullName}
            initials={initials === '—' ? 'NM' : initials}
          />
          <span className="vnext-meri__avatar-status" aria-hidden="true" />
        </span>

        <span className="vnext-meri__topbar-divider" />

        <button
          type="button"
          className="vnext-meri__chrome-btn"
          title="Dock Meri"
          aria-label="Dock Meri"
          onClick={onDock}
        >
          <MeriIcon name="Minus" size={16} color="#667085" />
        </button>
        <button
          type="button"
          className="vnext-meri__chrome-btn"
          title={windowChrome === 'maximized' ? 'Restore window' : 'Maximise window'}
          aria-label={windowChrome === 'maximized' ? 'Restore window' : 'Maximise window'}
          onClick={onToggleMaximize}
        >
          <MeriIcon
            name={windowChrome === 'maximized' ? 'Minimize01' : 'Maximize01'}
            size={15}
            color="#667085"
          />
        </button>
        <button
          type="button"
          className="vnext-meri__chrome-btn vnext-meri__chrome-btn--close"
          title="Close Meri"
          aria-label="Close Meri"
          onClick={onClose}
        >
          <MeriIcon name="XClose" size={16} color="#667085" />
        </button>
      </div>
    </header>
  );
}
