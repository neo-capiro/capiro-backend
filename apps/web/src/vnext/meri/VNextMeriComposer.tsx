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
import { maySend } from '../../components/chat/meri-route-guards.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon } from './meri-icons.js';

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
  const toast = useCapiroToast();
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLDivElement>(null);

  const {
    isStreaming,
    clients,
    selectedClientValue,
    stagedAttachments,
    attachmentNotice,
    handleAttachFiles,
    removeStagedAttachment,
    sendMessage,
    handleStop,
    scopePersistStatus,
  } = controller;

  const uploadsInFlight = stagedAttachments.some((attachment) => attachment.status === 'uploading');
  const busy = isStreaming || submitting;
  // Unified send gate: route/session ownership and first-send ownership are
  // enforced inside the send path. This predicate covers the remaining
  // durable-transition gate (scope persistence). Both the Send button and
  // the keyboard path (Enter / Cmd+Enter) use this same predicate.
  const canSend = maySend(busy, scopePersistStatus) && !uploadsInFlight;
  const selectedClient = clients.find((client) => client.id === selectedClientValue) ?? null;
  const contextLabel = selectedClient
    ? `${selectedClient.name.toUpperCase()} · CAPIRO CONTEXT`
    : 'CAPIRO SOURCES IN CONTEXT';

  useEffect(() => {
    if (!hasThread) textareaRef.current?.focus();
  }, [hasThread]);

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
      // Unified send gate: same predicate as the Send button and keyboard path.
      if (!maySend(busy, scopePersistStatus) || uploadsInFlight) return;
      if (!content) {
        toast.success('Write a message, then press Send.');
        return;
      }

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
    [busy, draft, sendMessage, toast, uploadsInFlight, scopePersistStatus],
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
            <span className="vnext-meri__add-popover-tile">
              <MeriIcon name="Plus" size={13} color="#101828" />
            </span>
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
            <span className="vnext-meri__add-popover-tile">
              <MeriIcon name="Edit01" size={13} color="#101828" />
            </span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Add note</span>
              <span className="vnext-meri__add-popover-item-desc">CAPTURE A THOUGHT OR IDEA</span>
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
            <span className="vnext-meri__add-popover-tile">H</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Connect HubSpot</span>
              <span className="vnext-meri__add-popover-item-desc">PULL CRM RECORDS</span>
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
            <span className="vnext-meri__add-popover-tile">S</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Connect SharePoint</span>
              <span className="vnext-meri__add-popover-item-desc">BROWSE TEAM DOCUMENTS</span>
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
            <span className="vnext-meri__add-popover-tile">A</span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Connect Airtable</span>
              <span className="vnext-meri__add-popover-item-desc">ATTACH BASE CONTEXT</span>
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
            <span className="vnext-meri__add-popover-tile">
              <MeriIcon name="LayersThree01" size={13} color="#101828" />
            </span>
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
                    <MeriIcon name="XClose" size={12} color="#98A2B3" />
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
              setAddOpen((open) => !open);
            }}
            aria-haspopup="menu"
            aria-expanded={addOpen}
          >
            <MeriIcon name="Plus" size={16} color="#475467" />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={busy}
            placeholder={
              isStreaming
                ? 'Meri is still researching. You can stop or add guidance…'
                : hasThread
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
          <span className="vnext-meri__composer-context-label">
            <MeriIcon name="Attachment01" size={13} color="#101828" />
            {contextLabel}
          </span>

          <span className="vnext-meri__composer-send-hint">
            {isStreaming
              ? 'STOP'
              : scopePersistStatus === 'saving'
                ? 'SAVING CLIENT SCOPE…'
                : scopePersistStatus === 'error'
                  ? 'SCOPE ERROR'
                  : submitting
                    ? 'STARTING…'
                    : 'SEND'}
          </span>

          {isStreaming ? (
            <button
              type="button"
              className="vnext-meri__composer-stop-btn"
              onClick={() => handleStop()}
              aria-label="Stop research"
            >
              <MeriIcon name="StopCircle" size={15} color="#344054" />
              Stop research
            </button>
          ) : (
            <button
              type="button"
              className={`vnext-meri__composer-send-btn${draft.trim() ? ' is-ready' : ' is-empty'}`}
              disabled={!canSend}
              onClick={() => void submit()}
              aria-label="Send"
            >
              <MeriIcon name="ArrowNarrowUp" size={17} color="#ffffff" />
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
