import { useCallback, useEffect, useRef, useState } from 'react';
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
}

function stagedAttachmentFailed(attachment: StagedAttachment): boolean {
  return (
    attachment.status === 'error' ||
    attachment.status === 'scanned' ||
    attachment.status === 'unsupported'
  );
}

export function VNextMeriComposer({ controller, variant, hasThread }: VNextMeriComposerProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
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
  const canSend = draft.trim().length > 0 && !isStreaming && !uploadsInFlight;
  const selectedClient = clients.find((client) => client.id === selectedClientValue) ?? null;
  const scopeLabel = selectedClient ? selectedClient.name.toUpperCase() : 'THREAD';
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
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [addOpen]);

  const submit = useCallback(
    (forced?: string) => {
      const content = (forced ?? draft).trim();
      if (!content || isStreaming || uploadsInFlight) return;
      void sendMessage(content);
      setDraft('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    },
    [draft, isStreaming, uploadsInFlight, sendMessage],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const composer = (
    <div className="vnext-meri__composer-wrap" ref={addRef}>
      {addOpen ? (
        <div className="vnext-meri__add-popover" role="menu" aria-label="Add to conversation">
          <div className="vnext-meri__add-popover-eyebrow">ADD TO CONVERSATION</div>
          <button
            type="button"
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
                ATTACH DOCUMENTS OR DATA
              </span>
            </span>
          </button>
          <button
            type="button"
            className="vnext-meri__add-popover-item"
            onClick={() => setAddOpen(false)}
          >
            <span className="vnext-meri__add-popover-tile">N</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Add note</span>
              <span className="vnext-meri__add-popover-item-desc">CAPTURE A THOUGHT OR IDEA</span>
            </span>
          </button>
          <button
            type="button"
            className="vnext-meri__add-popover-item"
            onClick={() => setAddOpen(false)}
          >
            <span className="vnext-meri__add-popover-tile">H</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Connect HubSpot</span>
              <span className="vnext-meri__add-popover-item-desc">PULL CRM RECORDS</span>
            </span>
          </button>
          <button
            type="button"
            className="vnext-meri__add-popover-item"
            onClick={() => setAddOpen(false)}
          >
            <span className="vnext-meri__add-popover-tile">S</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Connect SharePoint</span>
              <span className="vnext-meri__add-popover-item-desc">BROWSE TEAM DOCUMENTS</span>
            </span>
          </button>
          <button
            type="button"
            className="vnext-meri__add-popover-item"
            onClick={() => setAddOpen(false)}
          >
            <span className="vnext-meri__add-popover-tile">A</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Connect Airtable</span>
              <span className="vnext-meri__add-popover-item-desc">ATTACH BASE CONTEXT</span>
            </span>
          </button>
          <button
            type="button"
            className="vnext-meri__add-popover-item"
            onClick={() => setAddOpen(false)}
          >
            <span className="vnext-meri__add-popover-tile">W</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Import from workspace</span>
              <span className="vnext-meri__add-popover-item-desc">REUSE CONTENT OR CHATS</span>
            </span>
          </button>
          <div className="vnext-meri__add-popover-footer">
            EVERYTHING ADDED HERE IS SCOPED TO THIS THREAD AND LOGGED
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
            disabled={isStreaming}
            onClick={() => setAddOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={addOpen}
          >
            +
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={isStreaming}
            placeholder={
              hasThread
                ? 'Ask about this thread, or draft an action…'
                : 'Ask across your clients, or start a piece of work…'
            }
            aria-label="Message Meri"
            onFocus={() => setFocused(true)}
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
              onClick={() => setScopeOpen((open) => !open)}
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
                /* transform must be cleared too: the class centres the topbar
                   copy of this menu with translateX(-50%), which here shifted
                   it 150px left of its trigger. */
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  transform: 'none',
                }}
              >
                <button
                  type="button"
                  className="vnext-meri__scope-menu-item"
                  onClick={() => setScopeOpen(false)}
                >
                  <span className="vnext-meri__scope-menu-item-label">This thread</span>
                  <span className="vnext-meri__scope-menu-item-meta">THREAD SOURCES</span>
                </button>
                {clients.map((client) => (
                  <button
                    type="button"
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

          <button type="button" className="vnext-meri__composer-context-label">
            {contextLabel}
          </button>

          <span className="vnext-meri__composer-send-hint">
            {isStreaming ? '■ STOP' : '⏎ SEND'}
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
              className={`vnext-meri__composer-send-btn${canSend ? '' : ''}`}
              disabled={!canSend}
              onClick={() => submit()}
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
