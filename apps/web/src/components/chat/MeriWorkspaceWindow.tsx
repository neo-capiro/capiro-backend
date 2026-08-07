import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckOutlined,
  CloseOutlined,
  DownOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { MeriLegacyDrawer } from './ChatDrawer.js';
import { SessionRail } from './SessionRail.js';
import type { MeriChatController } from './useMeriChatController.js';
import meriBubbleImage from '../../assets/chat/meri-bubble.png';
import './meri-workspace-window.css';
import './meri-workspace-window-scope.css';

const REASONING_MODES = [
  {
    mode: 'fast',
    label: 'Fast',
    description: 'Quick answers and direct lookups.',
  },
  {
    mode: 'standard',
    label: 'Standard',
    description: 'Balanced everyday reasoning.',
  },
  {
    mode: 'deep',
    label: 'Deep',
    description: 'More investigation for strategic work.',
  },
  {
    mode: 'max',
    label: 'Max',
    description: 'Highest configured reasoning tier.',
  },
] as const;

type ReasoningMode = (typeof REASONING_MODES)[number]['mode'];

export function MeriWorkspaceWindow({ controller }: { controller: MeriChatController }) {
  const api = useApi();
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>('standard');
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const activeConversationId = controller.activeConversationId;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Meri — Capiro';
    document.documentElement.classList.add('meri-v3-window-document');
    document.body.classList.add('meri-v3-window-document');
    return () => {
      document.title = previousTitle;
      document.documentElement.classList.remove('meri-v3-window-document');
      document.body.classList.remove('meri-v3-window-document');
    };
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setReasoningMode('standard');
      return;
    }
    let cancelled = false;
    void api
      .get<{ reasoningMode: ReasoningMode }>(
        `/api/clio/v3/conversations/${activeConversationId}/reasoning-mode`,
      )
      .then(({ data }) => {
        if (!cancelled) setReasoningMode(data.reasoningMode ?? 'standard');
      })
      .catch(() => {
        if (!cancelled) setReasoningMode('standard');
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, api]);

  const changeReasoningMode = useCallback(
    async (next: ReasoningMode) => {
      if (!activeConversationId || savingMode || next === reasoningMode) return;
      const previous = reasoningMode;
      setReasoningMode(next);
      setSavingMode(true);
      setModeError(null);
      try {
        await api.patch(`/api/clio/v3/conversations/${activeConversationId}/reasoning-mode`, {
          reasoningMode: next,
        });
      } catch {
        setReasoningMode(previous);
        setModeError('The reasoning mode could not be saved.');
      } finally {
        setSavingMode(false);
      }
    },
    [activeConversationId, api, reasoningMode, savingMode],
  );

  return (
    <section className="meri-v3-workspace" aria-label="Meri workspace">
      <aside className="meri-v3-workspace-sidebar" aria-label="Meri conversations">
        <div className="meri-v3-workspace-brand">
          <span className="meri-v3-workspace-avatar" aria-hidden="true">
            <img src={meriBubbleImage} alt="" />
            <span />
          </span>
          <span>
            <strong>Meri</strong>
            <small>AI Chief of Staff</small>
          </span>
        </div>
        <button
          type="button"
          className="meri-v3-new-thread"
          onClick={() => void controller.handleNewSession()}
          aria-label="New thread"
        >
          <PlusOutlined aria-hidden="true" />
          New thread
        </button>
        <div className="meri-v3-thread-rail">
          <SessionRail forceOpen />
        </div>
        <div className="meri-v3-sidebar-footer">
          <span className="meri-v3-online-dot" aria-hidden="true" />
          Capiro intelligence connected
        </div>
      </aside>

      <main className="meri-v3-workspace-main">
        <header className="meri-v3-workspace-header">
          <div className="meri-v3-conversation-identity">
            <input
              value={controller.sessionTitle}
              onChange={(event) => controller.setSessionTitle(event.target.value)}
              onBlur={() => void controller.saveConversationMeta()}
              maxLength={160}
              aria-label="Conversation title"
            />
            <select
              value={controller.selectedClientValue}
              onChange={(event) => void controller.changeSessionClient(event.target.value)}
              disabled={!activeConversationId || controller.isSavingMeta}
              aria-label="Conversation client scope"
              title="Conversation client scope"
            >
              <option value="">General</option>
              {controller.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>
          <div className="meri-v3-header-actions">
            <ReasoningModePicker
              value={reasoningMode}
              disabled={!activeConversationId || savingMode}
              error={modeError}
              onChange={(mode) => void changeReasoningMode(mode)}
            />
            <span className="meri-v3-runtime-badge">
              <RobotOutlined /> MeriV3
            </span>
            <button
              type="button"
              className="meri-v3-close-window"
              onClick={() => window.close()}
              aria-label="Close Meri window"
              title="Close Meri window"
            >
              <CloseOutlined />
            </button>
          </div>
        </header>
        {controller.metaError ? (
          <div className="meri-v3-workspace-error" role="alert">
            {controller.metaError}
          </div>
        ) : null}

        <div className="meri-v3-workspace-body">
          <MeriLegacyDrawer
            controller={controller}
            embedded
            surface="undocked"
            showSessionRail={false}
          />
        </div>
      </main>
    </section>
  );
}

function ReasoningModePicker({
  value,
  disabled,
  error,
  onChange,
}: {
  value: ReasoningMode;
  disabled: boolean;
  error: string | null;
  onChange: (mode: ReasoningMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = REASONING_MODES.find((item) => item.mode === value) ?? REASONING_MODES[1];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="meri-v3-reasoning-picker" ref={rootRef}>
      <button
        type="button"
        className="meri-v3-reasoning-trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Reasoning mode: ${selected.label}`}
      >
        <span className="meri-v3-reasoning-spark" aria-hidden="true" />
        {selected.label}
        <DownOutlined />
      </button>
      {open ? (
        <div className="meri-v3-reasoning-menu" role="listbox" aria-label="Reasoning mode">
          {REASONING_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="option"
              aria-selected={item.mode === value}
              onClick={() => {
                onChange(item.mode);
                setOpen(false);
              }}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              {item.mode === value ? <CheckOutlined /> : null}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <span className="meri-v3-mode-error">{error}</span> : null}
    </div>
  );
}
