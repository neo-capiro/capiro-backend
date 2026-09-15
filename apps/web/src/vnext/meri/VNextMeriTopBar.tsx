import { useEffect, useMemo, useRef, useState } from 'react';
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

/** "What Meri can do" content, kept within capabilities exposed by the build. */
const PRO_TIPS = [
  {
    n: '01',
    title: 'Tell Meri to remember things',
    body: 'Say it plainly in the thread — “remember that this principal prefers one-page briefs” — and Meri proposes it as institutional memory. You approve it before it sticks, and future answers for that client can use it.',
    quote: '"Remember: we never cite draft RFP language with clients."',
  },
  {
    n: '02',
    title: 'Run an approved skill',
    body: 'Invoke a published firm skill by name. Firm administrators create and publish skills in Settings before they become available in this workspace.',
    quote:
      '"Run Monday Brief for my active clients and show me anything that needs a decision."',
    then: 'FIRM SKILLS ARE GOVERNED IN SETTINGS',
  },
  {
    n: '03',
    title: 'Ask for the deliverable, not the tool',
    body: 'Ask for the memo, target list or email; Meri assembles it, cites it, and surfaces any consequential step for approval.',
    quote:
      '"Draft the client update for Lockheed and send it to Jordan once I have reviewed it."',
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
  const [scopeQuery, setScopeQuery] = useState('');
  const [tipOpen, setTipOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const { clients, selectedClientValue, changeSessionClient } = controller;
  const selectedClient = clients.find((client) => client.id === selectedClientValue) ?? null;
  // v6 reference: the chip carries the client's exact recorded name in its own
  // casing ("Overland AI"), never an uppercased rewrite.
  const scopeLabel = selectedClient ? selectedClient.name : 'All clients';
  const scopeMeta = selectedClient ? 'CLIENT' : `${clients.length} IN SCOPE`;

  /**
   * The scope the server has actually recorded against this thread. Only shown
   * once a thread exists AND the recorded scope differs from what the picker is
   * currently showing — otherwise the row would just duplicate the selection.
   */
  const threadScope = useMemo(() => {
    if (!controller.activeConversationId) return null;
    const persisted = controller.persistedClientId;
    if ((persisted ?? '') === (selectedClientValue ?? '')) return null;
    if (!persisted) return { id: '', label: 'ALL CLIENTS · PORTFOLIO' };
    const client = clients.find((candidate) => candidate.id === persisted);
    return client ? { id: client.id, label: client.name.toUpperCase() } : null;
  }, [clients, controller.activeConversationId, controller.persistedClientId, selectedClientValue]);

  const filteredClients = useMemo(() => {
    const query = scopeQuery.trim().toLowerCase();
    if (!query) return clients;
    return clients.filter((client) => client.name.toLowerCase().includes(query));
  }, [clients, scopeQuery]);

  const showAllClients = useMemo(() => {
    const query = scopeQuery.trim().toLowerCase();
    if (!query) return true;
    return 'all clients · portfolio'.includes(query) || 'portfolio'.includes(query);
  }, [scopeQuery]);

  const firstName = me?.user.firstName?.trim() ?? '';
  const lastName = me?.user.lastName?.trim() ?? '';
  const fullName = `${firstName} ${lastName}`.trim() || me?.user.email?.split('@')[0] || 'User';
  const initials = identityInitials(fullName);

  useEffect(() => {
    if (!scopeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (scopeRef.current?.contains(target)) return;
      setScopeOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [scopeOpen, setScopeOpen]);

  useEffect(() => {
    if (!scopeOpen) setScopeQuery('');
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
  }, [setScopeOpen]);

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
          <span className="vnext-meri__brand-label">AI Chief of Staff</span>
        </span>
      </div>

      <div className="vnext-meri__scope" ref={scopeRef}>
        <button
          type="button"
          className="vnext-meri__scope-trigger"
          disabled={controller.isStreaming}
          onClick={() => setScopeOpen(!scopeOpen)}
          aria-haspopup="menu"
          aria-expanded={scopeOpen}
          title="Conversation scope"
        >
          <MeriIcon name={selectedClient ? 'Building01' : 'Grid01'} size={14} color="#101828" />
          <span className="vnext-meri__scope-label">{scopeLabel}</span>
          <span className="vnext-meri__scope-divider" />
          <span className="vnext-meri__scope-meta">{scopeMeta}</span>
          <MeriIcon name="ChevronDown" size={14} color="#98A2B3" />
        </button>
        {scopeOpen ? (
          <div className="vnext-meri__scope-menu" role="menu" aria-label="Conversation scope">
            <div className="vnext-meri__scope-menu-eyebrow">CONVERSATION SCOPE</div>
            <div className="vnext-meri__scope-menu-search">
              <MeriIcon name="SearchLg" size={14} color="#98A2B3" />
              <input
                type="search"
                value={scopeQuery}
                onChange={(event) => setScopeQuery(event.target.value)}
                placeholder="Search clients…"
                aria-label="Search clients"
              />
            </div>
            {/*
              Thread's recorded scope (handoff §1a first row). The prototype
              labels this `FIXED AT CREATION`, but in this build changing scope
              IS an audited move that affects later answers (handoff §State
              management), so the meta states the recorded scope rather than
              claiming immutability the server does not enforce. Selecting it
              returns the picker to what the server has on record.
            */}
            {threadScope ? (
              <button
                type="button"
                role="menuitem"
                className={`vnext-meri__scope-menu-item${
                  threadScope.id === selectedClientValue ? ' is-selected' : ''
                }`}
                onClick={() => {
                  setScopeOpen(false);
                  void changeSessionClient(threadScope.id);
                }}
              >
                <span className="vnext-meri__scope-menu-item-body">
                  <span className="vnext-meri__scope-menu-item-label">This thread</span>
                  <span className="vnext-meri__scope-menu-item-meta">
                    RECORDED SCOPE · {threadScope.label}
                  </span>
                </span>
                {threadScope.id === selectedClientValue ? (
                  <MeriIcon name="Check" size={15} color="#101828" />
                ) : null}
              </button>
            ) : null}
            {filteredClients.map((client) => (
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
                <span className="vnext-meri__scope-menu-item-body">
                  <span className="vnext-meri__scope-menu-item-label">{client.name}</span>
                  <span className="vnext-meri__scope-menu-item-meta">CLIENT</span>
                </span>
                {client.id === selectedClientValue ? (
                  <MeriIcon name="Check" size={15} color="#101828" />
                ) : null}
              </button>
            ))}
            {showAllClients ? (
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
                <span className="vnext-meri__scope-menu-item-body">
                  <span className="vnext-meri__scope-menu-item-label">
                    All clients · Portfolio
                  </span>
                  <span className="vnext-meri__scope-menu-item-meta">
                    {clients.length} CLIENTS
                  </span>
                </span>
                {!selectedClientValue ? (
                  <MeriIcon name="Check" size={15} color="#101828" />
                ) : null}
              </button>
            ) : null}
            <div className="vnext-meri__scope-menu-footnote">
              Scope is durable conversation context, not a filter. It changes what Meri may read.
            </div>
          </div>
        ) : null}
      </div>

      <div className="vnext-meri__topbar-actions">
        <button
          type="button"
          className="vnext-meri__icon-btn"
          title="Search — ⌘K"
          aria-label="Search threads"
          onClick={onSearch}
        >
          <MeriIcon name="SearchLg" size={17} color="#475467" />
        </button>
        <button
          type="button"
          className="vnext-meri__icon-btn"
          title="New thread"
          aria-label="Start a new thread"
          onClick={onNewChat}
        >
          <MeriIcon name="Plus" size={17} color="#475467" />
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
            WHAT MERI CAN DO
          </button>
          {tipOpen ? (
            <div
              className="vnext-meri__protip-panel"
              role="dialog"
              aria-label="What Meri can do"
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
