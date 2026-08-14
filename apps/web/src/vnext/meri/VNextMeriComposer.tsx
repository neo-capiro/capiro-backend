import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  attachmentKindIcon,
  truncateFilenameMiddle,
  type StagedAttachment,
} from '../../components/chat/ChatInput.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

const ATTACH_ACCEPT = '.pdf,.docx,.txt,.md,.csv,image/png,image/jpeg,image/gif,image/webp';

interface VNextMeriComposerProps {
  controller: MeriChatController;
  variant: 'landing' | 'pinned';
  /** Whether the thread has messages (affects placeholder). */
  hasThread: boolean;
  onOpenIntegrations: () => void;
}

function stagedAttachmentFailed(attachment: StagedAttachment): boolean {
  return (
    attachment.status === 'error' ||
    attachment.status === 'scanned' ||
    attachment.status === 'unsupported'
  );
}

export function VNextMeriComposer({
  controller,
  variant,
  hasThread,
  onOpenIntegrations,
}: VNextMeriComposerProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);

  const {
    isStreaming,
    clients,
    selectedClientValue,
    changeSessionClient,
    stagedAttachments,
    attachmentNotice,
    handleAttachFiles,
    removeStagedAttachment,
    sendMessage,
    handleStop,
  } = controller;

  const uploadsInFlight = stagedAttachments.some((attachment) => attachment.status === 'uploading');
  const busy = isStreaming || submitting;
  const canSend = draft.trim().length > 0 && !busy && !uploadsInFlight;
  const selectedClient = clients.find((client) => client.id === selectedClientValue) ?? null;
  const scopeLabel = selectedClient ? selectedClient.name.toUpperCase() : 'ALL CLIENTS';
  const contextLabel = selectedClient
    ? `${selectedClient.name.toUpperCase()} · CAPIRO CONTEXT`
    : 'CAPIRO SOURCES IN CONTEXT';

  useEffect(() => {
    if (!hasThread) textareaRef.current?.focus();
  }, [hasThread]);

  useEffect(() => {
    if (!scopeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!scopeRef.current?.contains(event.target as Node)) setScopeOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setScopeOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [scopeOpen]);

  useEffect(() => {
    if (!addOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setAddOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [addOpen]);

  const submit = useCallback(
    async (forced?: string) => {
      const content = (forced ?? draft).trim();
      if (!content || busy || uploadsInFlight) return;

      // Clear optimistically so accepted messages feel immediate, but restore
      // the exact text when route-level creation rejects the send. The old
      // composer discarded the user's first prompt even when no thread existed.
      setSubmitting(true);
      setDraft('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      try {
        await sendMessage(content);
      } catch {
        setDraft((current) => current || content);
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      } finally {
        setSubmitting(false);
      }
    },
    [busy, draft, sendMessage, uploadsInFlight],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter confirms an IME composition on many keyboards. Sending that event
    // truncated Japanese/Chinese/Korean input before the browser committed it.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const composer = (
    <div className="vnext-meri__composer-wrap" ref={addRef}>
      {addOpen ? (
        <div className="vnext-meri__add-popover" role="menu" aria-label="Add to conversation">
          <div className="vnext-meri__add-popover-eyebrow">ADD TO CONVERSATION</div>
          <button
            type="button"
            role="menuitem"
            className="vnext-meri__add-popover-item"
            onClick={() => {
              setAddOpen(false);
              fileInputRef.current?.click();
            }}
          >
            <span className="vnext-meri__add-popover-tile">+</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Upload file</span>
              <span className="vnext-meri__add-popover-item-desc">
                ATTACH DOCUMENTS, DATA, OR IMAGES
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="vnext-meri__add-popover-item"
            onClick={() => {
              setAddOpen(false);
              setDraft((current) => (current ? `${current}\n\nNote: ` : 'Note: '));
              window.setTimeout(() => textareaRef.current?.focus(), 0);
            }}
          >
            <span className="vnext-meri__add-popover-tile">N</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Add note</span>
              <span className="vnext-meri__add-popover-item-desc">CAPTURE CONTEXT IN THIS TURN</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="vnext-meri__add-popover-item"
            onClick={() => {
              setAddOpen(false);
              onOpenIntegrations();
            }}
          >
            <span className="vnext-meri__add-popover-tile">C</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Manage connected apps</span>
              <span className="vnext-meri__add-popover-item-desc">HUBSPOT, AIRTABLE, AND MORE</span>
            </span>
          </button>
          <div className="vnext-meri__add-popover-footer">
            FILES ARE SCOPED TO THIS TURN · APP ACCESS FOLLOWS TENANT POLICY
          </div>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        hidden
        onChange={(event) => {
          if (event.target.files?.length) handleAttachFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <div className={`vnext-meri__composer${focused ? ' is-focused' : ''}`}>
        {stagedAttachments.length > 0 ? (
          <div className="vnext-meri__attachments" aria-label="Attached files">
            {stagedAttachments.map((attachment) => {
              const failed = stagedAttachmentFailed(attachment);
              return (
                <span
                  key={attachment.localId}
                  className={`vnext-meri__attachment${failed ? ' is-error' : ''}`}
                >
                  <span aria-hidden="true">{attachmentKindIcon(attachment.kind)}</span>
                  <span title={attachment.filename}>
                    {truncateFilenameMiddle(attachment.filename, 28)}
                  </span>
                  <span className="vnext-meri__attachment-state">
                    {attachment.status === 'uploading'
                      ? 'UPLOADING'
                      : failed
                        ? 'UNAVAILABLE'
                        : attachment.status === 'truncated'
                          ? 'TRUNCATED'
                          : 'READY'}
                  </span>
                  <button
                    type="button"
                    className="vnext-meri__attachment-remove"
                    onClick={() => removeStagedAttachment(attachment.localId)}
                    aria-label={`Remove ${attachment.filename}`}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}

        {attachmentNotice ? (
          <div className="vnext-meri__attachment-notice" role="status">
            {attachmentNotice}
          </div>
        ) : null}

        <div className="vnext-meri__composer-row">
          <button
            type="button"
            className="vnext-meri__composer-add-btn"
            title="Add to conversation"
            disabled={busy}
            onClick={() => {
              setScopeOpen(false);
              setAddOpen((open) => !open);
            }}
            aria-haspopup="menu"
            aria-expanded={addOpen}
          >
            +
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={busy}
            placeholder={
              hasThread
                ? 'Ask about this thread, or draft an action…'
                : 'Ask across your clients, or start a piece of work…'
            }
            aria-label="Message Meri"
            onFocus={() => {
              setFocused(true);
              setAddOpen(false);
            }}
            onBlur={() => setFocused(false)}
            onChange={(event) => setDraft(event.target.value)}
            onInput={(event) => {
              const element = event.currentTarget;
              element.style.height = 'auto';
              element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
            }}
            onKeyDown={onKeyDown}
            className="vnext-meri__composer-textarea"
          />
        </div>

        <div className="vnext-meri__composer-toolbar">
          <div className="vnext-meri__composer-scope-control" ref={scopeRef}>
            <button
              type="button"
              className="vnext-meri__composer-scope-btn"
              disabled={busy}
              onClick={() => {
                setAddOpen(false);
                setScopeOpen((open) => !open);
              }}
              aria-haspopup="menu"
              aria-expanded={scopeOpen}
            >
              SCOPE: {scopeLabel} ▾
            </button>
            {scopeOpen ? (
              <div
                className="vnext-meri__scope-menu"
                role="menu"
                aria-label="Conversation scope"
                /* The shared class is topbar-centred (`top: 44px` plus a
                   translate). Clear every opposing property for the composer
                   copy so it stays anchored above its own trigger. */
                style={{
                  position: 'absolute',
                  top: 'auto',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  transform: 'none',
                }}
              >
                {clients.map((client) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={client.id}
                    className="vnext-meri__scope-menu-item"
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
                  className="vnext-meri__scope-menu-item"
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

          <span className="vnext-meri__composer-context-label">{contextLabel}</span>

          <span className="vnext-meri__composer-send-hint">
            {isStreaming ? '■ STOP' : submitting ? 'STARTING…' : '⏎ SEND'}
          </span>

          {isStreaming ? (
            <button
              type="button"
              className="vnext-meri__composer-stop-btn"
              onClick={() => handleStop()}
              aria-label="Stop generating"
            >
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className={`vnext-meri__composer-send-btn${canSend ? ' is-ready' : ''}`}
              disabled={!canSend}
              onClick={() => void submit()}
              aria-label="Send"
            >
              ↑
            </button>
          )}
        </div>
      </div>

      <div className="vnext-meri__composer-policy">
        MERI CITES SOURCES · NETWORK WRITES AND EXTERNAL SENDS REQUIRE YOUR APPROVAL
      </div>
    </div>
  );

  if (variant === 'landing') {
    return <div className="vnext-meri__landing-composer">{composer}</div>;
  }

  return (
    <div className="vnext-meri__composer-pinned">
      <div className="vnext-meri__composer-pinned-inner">{composer}</div>
    </div>
  );
}
