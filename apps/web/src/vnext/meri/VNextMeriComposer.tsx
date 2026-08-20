import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  truncateFilenameMiddle,
  type StagedAttachment,
} from '../../components/chat/chat-attachments.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { maySend, meriEffectiveIdentityKey } from '../../components/chat/meri-route-guards.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import { MeriIcon } from './meri-icons.js';
import { ConnectorMark } from './meri-connector-logos.js';
import {
  mayApplyWorkspaceImportResponse,
  workspaceDocumentComposerText,
  workspaceImportDocumentsResponse,
  workspaceImportDraftsResponse,
  type MeriWorkspaceImportDraft,
} from './meri-workspace-import.js';

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

/**
 * vNext-native kind→icon mapping — same convention as MeriAttachmentChip's
 * attachmentChipSpec (image→Eye, docx→File04, otherwise File05). Replaces the
 * antd attachmentKindIcon the legacy composer renders; antd may not render on
 * the vNext surface.
 */
function stagedAttachmentIconName(kind: StagedAttachment['kind']): 'Eye' | 'File04' | 'File05' {
  return kind === 'image' ? 'Eye' : kind === 'docx' ? 'File04' : 'File05';
}

export function VNextMeriComposer({
  controller,
  variant,
  hasThread,
  onOpenIntegrations,
}: VNextMeriComposerProps) {
  const toast = useCapiroToast();
  const api = useApi();
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const workspaceIdentityKey = meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
  const workspaceIdentityKeyRef = useRef(workspaceIdentityKey);
  workspaceIdentityKeyRef.current = workspaceIdentityKey;
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [workspaceImportOpen, setWorkspaceImportOpen] = useState(false);
  const [workspaceDrafts, setWorkspaceDrafts] = useState<MeriWorkspaceImportDraft[]>([]);
  const [workspaceImportLoading, setWorkspaceImportLoading] = useState(false);
  const [workspaceImportError, setWorkspaceImportError] = useState<string | null>(null);
  const [workspaceDocuments, setWorkspaceDocuments] = useState<
    Record<string, Array<{ id: string; name: string }> | null>
  >({});
  const [workspaceDocumentLoading, setWorkspaceDocumentLoading] = useState<string | null>(null);
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

  // Listen for intent fills from MeriStartWork cards.
  useEffect(() => {
    const onFill = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (typeof text === 'string' && text.trim()) {
        setDraft(text);
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      }
    };
    window.addEventListener('meri-fill-draft', onFill);
    return () => window.removeEventListener('meri-fill-draft', onFill);
  }, []);

  const workspaceRequest = useCallback(
    async (path: string) => {
      const { data } = await api.get(path);
      return data as unknown;
    },
    [api],
  );

  // Workspace drafts are tenant-private. Do not keep a prior tenant's list or
  // selected document visible while the Clerk organization / admin impersonation
  // changes; the next request is made only in the new authenticated context.
  const previousWorkspaceIdentityKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (previousWorkspaceIdentityKeyRef.current === null) {
      previousWorkspaceIdentityKeyRef.current = workspaceIdentityKey;
      return;
    }
    if (previousWorkspaceIdentityKeyRef.current === workspaceIdentityKey) return;
    previousWorkspaceIdentityKeyRef.current = workspaceIdentityKey;
    setDraft('');
    setWorkspaceImportOpen(false);
    setWorkspaceDrafts([]);
    setWorkspaceDocuments({});
    setWorkspaceImportError(null);
    setWorkspaceImportLoading(false);
    setWorkspaceDocumentLoading(null);
  }, [workspaceIdentityKey]);

  useEffect(() => {
    if (!workspaceImportOpen) return;
    let cancelled = false;
    const requestIdentityKey = workspaceIdentityKey;
    setWorkspaceImportLoading(true);
    setWorkspaceImportError(null);
    void workspaceRequest('/workspace-api/drafts?scope=all')
      .then((data) => {
        if (!mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current) || cancelled) return;
        setWorkspaceDrafts(workspaceImportDraftsResponse(data));
        setWorkspaceDocuments({});
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceDrafts([]);
          setWorkspaceImportError('Workspace documents could not be loaded.');
        }
      })
      .finally(() => {
        if (!cancelled && mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current)) {
          setWorkspaceImportLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceIdentityKey, workspaceImportOpen, workspaceRequest]);

  const loadWorkspaceDocument = useCallback(
    async (draftId: string, documentId: string) => {
      const requestIdentityKey = workspaceIdentityKeyRef.current;
      setWorkspaceDocumentLoading(documentId);
      setWorkspaceImportError(null);
      try {
        const data = await workspaceRequest(
          `/workspace-api/drafts/${encodeURIComponent(draftId)}/documents/${encodeURIComponent(documentId)}/meri-import`,
        );
        if (!mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current)) return;
        const composerText = workspaceDocumentComposerText(data);
        if (!composerText) {
          setWorkspaceImportError('This workspace document has no readable text.');
          return;
        }
        setDraft((current) => (current.trim() ? `${current.trim()}\n\n${composerText}` : composerText));
        setWorkspaceImportOpen(false);
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      } catch {
        if (mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current)) {
          setWorkspaceImportError('The workspace document could not be loaded.');
        }
      } finally {
        if (mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current)) {
          setWorkspaceDocumentLoading(null);
        }
      }
    },
    [workspaceRequest],
  );

  const loadWorkspaceDraftDocuments = useCallback(
    async (draftId: string) => {
      if (workspaceDocuments[draftId] !== undefined) {
        setWorkspaceDocuments((current) => ({ ...current, [draftId]: null }));
        return;
      }
      const requestIdentityKey = workspaceIdentityKeyRef.current;
      setWorkspaceDocumentLoading(draftId);
      setWorkspaceImportError(null);
      try {
        const data = await workspaceRequest(`/workspace-api/drafts/${encodeURIComponent(draftId)}/documents/meri-import`);
        if (!mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current)) return;
        const documents = workspaceImportDocumentsResponse(data);
        setWorkspaceDocuments((current) => ({ ...current, [draftId]: documents }));
        if (!documents.length) setWorkspaceImportError('This workspace draft has no readable documents.');
      } catch {
        if (mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current)) {
          setWorkspaceImportError('The workspace draft could not be loaded.');
        }
      } finally {
        if (mayApplyWorkspaceImportResponse(requestIdentityKey, workspaceIdentityKeyRef.current)) {
          setWorkspaceDocumentLoading(null);
        }
      }
    },
    [workspaceDocuments, workspaceRequest],
  );

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
              <span className="vnext-meri__add-popover-item-desc">ADDS EDITABLE TEXT TO THIS MESSAGE</span>
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
            <span className="vnext-meri__add-popover-tile"><ConnectorMark id="hubspot" size={15} /></span>
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
            <span className="vnext-meri__add-popover-tile"><ConnectorMark id="sharepoint" size={15} /></span>
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
            <span className="vnext-meri__add-popover-tile"><ConnectorMark id="airtable" size={15} /></span>
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
              setWorkspaceImportOpen(true);
            }}
          >
            <span className="vnext-meri__add-popover-tile">
              <MeriIcon name="LayersThree01" size={13} color="#101828" />
            </span>
            <span className="vnext-meri__add-popover-item-body">
              <span className="vnext-meri__add-popover-item-label">Import from workspace</span>
              <span className="vnext-meri__add-popover-item-desc">REVIEW A DOCUMENT BEFORE ADDING IT TO THE DRAFT</span>
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
                  <span aria-hidden="true" style={{ display: 'flex' }}>
                    <MeriIcon name={stagedAttachmentIconName(attachment.kind)} size={12} />
                  </span>
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
          <button
            type="button"
            className="vnext-meri__composer-context-label"
            onClick={() => setAddOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            title="Add context to this thread"
          >
            <MeriIcon name="Attachment01" size={13} color="#101828" />
            {contextLabel}
          </button>

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
              Stop
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
        MERI CITES SOURCES · EXTERNAL SENDS AND NETWORK WRITES REQUIRE YOUR APPROVAL
      </div>
    </div>
  );

  const workspaceImportDialog = workspaceImportOpen ? (
    <div className="vnext-meri__confirm-scrim" role="presentation">
      <div
        className="vnext-meri__confirm-dialog vnext-meri__workspace-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meri-workspace-import-title"
      >
        <div id="meri-workspace-import-title" className="vnext-meri__confirm-title">
          Import from workspace
        </div>
        <div className="vnext-meri__confirm-body">
          Select a document to add as editable text. It stays in this draft until you review and send it.
        </div>
        {workspaceImportLoading ? <div className="vnext-meri__ctx-empty">Loading workspace documents…</div> : null}
        {workspaceImportError ? <div className="vnext-meri__ctx-empty">{workspaceImportError}</div> : null}
        {!workspaceImportLoading && !workspaceImportError && workspaceDrafts.length === 0 ? (
          <div className="vnext-meri__ctx-empty">No workspace documents are available.</div>
        ) : null}
        <div className="vnext-meri__move-workspace-list">
          {workspaceDrafts.map((workspaceDraft) => {
            const documents = workspaceDocuments[workspaceDraft.id];
            const loading = workspaceDocumentLoading === workspaceDraft.id;
            return (
              <div key={workspaceDraft.id} className="vnext-meri__workspace-draft">
                <button
                  type="button"
                  className="vnext-meri__workspace-item"
                  onClick={() => void loadWorkspaceDraftDocuments(workspaceDraft.id)}
                  aria-expanded={documents !== undefined && documents !== null}
                >
                  <span className="vnext-meri__workspace-copy">
                    <span className="vnext-meri__workspace-name">{workspaceDraft.docTitle}</span>
                    <span className="vnext-meri__workspace-meta">
                      {workspaceDraft.clientName ?? 'Workspace draft'}
                    </span>
                  </span>
                  <span className="vnext-meri__workspace-meta">{loading ? 'LOADING…' : 'VIEW DOCUMENTS'}</span>
                </button>
                {documents?.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    className="vnext-meri__workspace-item vnext-meri__workspace-document"
                    disabled={workspaceDocumentLoading === document.id}
                    onClick={() => void loadWorkspaceDocument(workspaceDraft.id, document.id)}
                  >
                    <span className="vnext-meri__workspace-copy">
                      <span className="vnext-meri__workspace-name">{document.name}</span>
                      <span className="vnext-meri__workspace-meta">ADD AS EDITABLE TEXT</span>
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="vnext-meri__confirm-actions">
          <button
            type="button"
            className="vnext-meri__confirm-cancel"
            onClick={() => setWorkspaceImportOpen(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (variant === 'landing') {
    return (
      <>
        <div className="vnext-meri__landing-composer">{composer}</div>
        {workspaceImportDialog}
      </>
    );
  }

  return (
    <>
      <div className="vnext-meri__composer-pinned">
        <div className="vnext-meri__composer-pinned-inner">{composer}</div>
      </div>
      {workspaceImportDialog}
    </>
  );
}
