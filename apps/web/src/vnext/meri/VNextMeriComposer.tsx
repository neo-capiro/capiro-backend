import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  truncateFilenameMiddle,
  type StagedAttachment,
} from '../../components/chat/chat-attachments.js';
import { useManagedMcpApps } from '../../components/chat/managed-mcp-apps.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { maySend, meriEffectiveIdentityKey } from '../../components/chat/meri-route-guards.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { useApi } from '../../lib/use-api.js';
import { useImpersonation } from '../../state/impersonation.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import { ConnectorMark } from './meri-connector-logos.js';
import { useMeriComposerDraft } from './meri-composer-drafts.js';
import { MERI_REASONING_MODES, useMeriReasoningMode } from './meri-reasoning-state.js';
import { meriStartWorkCards } from './meri-start-work.js';
import {
  deleteMeriSavedPrompt,
  listMeriSavedPrompts,
  type MeriSavedPrompt,
} from './meri-vnext-api.js';
import {
  workspaceDocumentComposerText,
  workspaceImportDocumentsResponse,
  workspaceImportDraftsResponse,
  type MeriWorkspaceImportDraft,
} from './meri-workspace-import.js';

// Any file type may be dropped or picked — the server's attachment pipeline
// decides what it can extract text from and marks unsupported files with an
// honest 'unsupported' status (never blocked client-side by extension).
const ATTACH_ACCEPT = undefined;

/**
 * LIBRARY sub-panes (v6 prototype `addPanes()`/`addPane()`): saved prompts,
 * skills, connectors and reasoning depth moved out of the rails and into the
 * add menu — "the add button is where a message gets its ingredients, so
 * the library belongs behind it, not beside it." Every pane fills the
 * composer or navigates; nothing here auto-sends or silently mutates state.
 */
type MeriLibraryPaneId = 'prompts' | 'skills' | 'connectors' | 'reasoning';

interface MeriLibraryPaneItem {
  key: string;
  label: string;
  desc: string;
  descFg?: string;
  icon: MeriIconName;
  hasBadge: boolean;
  badge?: string;
  badgeBg?: string;
  badgeFg?: string;
  canDel: boolean;
  disabled?: boolean;
  delLabel?: string;
  run: () => void;
  del?: () => void;
}

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
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPane, setAddPane] = useState<MeriLibraryPaneId | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const [workspaceImportOpen, setWorkspaceImportOpen] = useState(false);
  const [workspaceDrafts, setWorkspaceDrafts] = useState<MeriWorkspaceImportDraft[]>([]);
  const [workspaceImportLoading, setWorkspaceImportLoading] = useState(false);
  const [workspaceImportError, setWorkspaceImportError] = useState<string | null>(null);
  const [workspaceDocuments, setWorkspaceDocuments] = useState<
    Record<string, Array<{ id: string; name: string }>>
  >({});
  const [workspaceExpanded, setWorkspaceExpanded] = useState<Record<string, boolean>>({});
  const [workspaceDraftLoading, setWorkspaceDraftLoading] = useState<Record<string, boolean>>({});
  const [workspaceDocumentLoading, setWorkspaceDocumentLoading] = useState<Record<string, boolean>>(
    {},
  );
  const workspaceDraftRequestsRef = useRef(new Set<string>());
  const workspaceDocumentRequestsRef = useRef(new Set<string>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const workspaceDialogRef = useRef<HTMLDivElement>(null);

  const {
    isStreaming,
    clients,
    selectedClientValue,
    activeConversationId,
    stagedAttachments,
    attachmentNotice,
    handleAttachFiles,
    removeStagedAttachment,
    sendMessage,
    handleStop,
    scopePersistStatus,
  } = controller;
  const { draft, setDraft, clearForSubmission } = useMeriComposerDraft(
    workspaceIdentityKey,
    activeConversationId,
  );
  const workspaceScopeKey = JSON.stringify([workspaceIdentityKey, activeConversationId]);
  const workspaceScopeRef = useRef(workspaceScopeKey);
  const workspaceRequestEpochRef = useRef(0);
  const workspaceOpenRef = useRef(workspaceImportOpen);
  const mountedRef = useRef(true);
  if (workspaceScopeRef.current !== workspaceScopeKey) {
    workspaceScopeRef.current = workspaceScopeKey;
    workspaceRequestEpochRef.current += 1;
  }
  workspaceOpenRef.current = workspaceImportOpen;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const mayApplyWorkspaceRequest = useCallback(
    (epoch: number) =>
      mountedRef.current && workspaceOpenRef.current && epoch === workspaceRequestEpochRef.current,
    [],
  );
  const closeWorkspaceImport = useCallback(() => {
    workspaceRequestEpochRef.current += 1;
    workspaceOpenRef.current = false;
    setWorkspaceImportOpen(false);
  }, []);

  useEffect(() => {
    if (!workspaceImportOpen) return;
    const returnFocus = addRef.current?.querySelector<HTMLButtonElement>('button');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    workspaceDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeWorkspaceImport();
        return;
      }
      const dialog = workspaceDialogRef.current;
      if (event.key !== 'Tab' || !dialog) return;
      const buttons = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [workspaceImportOpen, closeWorkspaceImport]);

  // v6: Task Mode has no dedicated toolbar control — RESEARCH stays reachable
  // via the Landing "Deep research" skill card and inline research offers;
  // WRITE is set by the page-write entry points that already call
  // controller.setWriteMode directly (not from this composer).

  const identityKey = meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
  const queryClient = useQueryClient();
  const managedApps = useManagedMcpApps();
  const selectedClient = clients.find((client) => client.id === selectedClientValue) ?? null;

  // LIBRARY: Saved prompts. Same query key convention as MeriStartWork, so a
  // delete from the composer's pane invalidates the landing's cards too.
  const promptsQuery = useQuery({
    queryKey: ['meri-vnext', identityKey, 'saved-prompts'],
    queryFn: () => listMeriSavedPrompts(api),
    staleTime: 30_000,
  });
  const skillsQuery = useQuery({
    queryKey: ['meri-vnext', identityKey, 'skills'],
    queryFn: async () => (await api.get('/api/clio/v3/skills')).data as unknown,
    staleTime: 30_000,
  });
  const startWorkCatalog = useMemo(
    () =>
      meriStartWorkCards({
        skills: skillsQuery.data,
        prompts: promptsQuery.data,
        clientName: selectedClient?.name ?? null,
      }),
    [promptsQuery.data, selectedClient?.name, skillsQuery.data],
  );

  // Header, landing and Add menu subscribe to the same per-identity/thread state.
  const {
    mode: reasoningMode,
    saving: reasoningSaving,
    error: reasoningError,
    chooseMode: setReasoningMode,
  } = useMeriReasoningMode(activeConversationId);
  const currentReasoning =
    MERI_REASONING_MODES.find((option) => option.mode === reasoningMode) ?? MERI_REASONING_MODES[1];

  const deletePrompt = useCallback(
    async (promptId: string) => {
      try {
        await deleteMeriSavedPrompt(api, promptId);
        await queryClient.invalidateQueries({
          queryKey: ['meri-vnext', identityKey, 'saved-prompts'],
        });
      } catch {
        toast.error('The saved prompt could not be deleted.');
      }
    },
    [api, identityKey, queryClient, toast],
  );

  const fillFromLibrary = useCallback(
    (text: string, notice: string) => {
      setDraft(text);
      setAddOpen(false);
      setAddPane(null);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
      toast.success(notice);
    },
    [toast, setDraft],
  );

  const libraryPromptItems = useMemo<MeriLibraryPaneItem[]>(
    () =>
      (promptsQuery.data ?? []).map((prompt: MeriSavedPrompt) => ({
        key: prompt.id,
        label: prompt.title,
        desc: prompt.body,
        icon: 'Bookmark',
        hasBadge: false,
        canDel: true,
        delLabel: `Delete ${prompt.title}`,
        run: () =>
          fillFromLibrary(
            prompt.body,
            `"${prompt.title}" filled the composer. Saved prompts never auto-send.`,
          ),
        del: () => void deletePrompt(prompt.id),
      })),
    [deletePrompt, fillFromLibrary, promptsQuery.data],
  );

  const librarySkillItems = useMemo<MeriLibraryPaneItem[]>(
    () =>
      startWorkCatalog.skills.map((card) => ({
        key: card.id,
        label: card.title,
        desc: card.desc,
        icon: card.icon,
        hasBadge: true,
        badge: card.needsClient ? 'CLIENT' : 'PORTFOLIO',
        badgeBg: card.needsClient ? '#FFFAEB' : '#F2F4F7',
        badgeFg: card.needsClient ? '#B54708' : '#475467',
        canDel: false,
        run: () => {
          if (card.needsClient && !selectedClient) {
            toast.success(
              `${card.title} needs a client in scope. Pick one from the scope chip first.`,
            );
            return;
          }
          fillFromLibrary(card.fill, `${card.title} filled the composer. Skills never auto-send.`);
        },
      })),
    [fillFromLibrary, selectedClient, startWorkCatalog.skills, toast],
  );

  const libraryConnectorItems = useMemo<MeriLibraryPaneItem[]>(
    () =>
      (managedApps?.apps ?? []).map((app) => {
        const status = app.needsReauth
          ? 'NEEDS REAUTH'
          : app.connected
            ? 'CONNECTED'
            : 'NOT CONNECTED';
        const tone = app.needsReauth
          ? { bg: '#FFFAEB', fg: '#B54708' }
          : app.connected
            ? { bg: '#ECFDF3', fg: '#027A48' }
            : { bg: '#F2F4F7', fg: '#475467' };
        return {
          key: app.id,
          label: app.name,
          desc: app.description || 'Manage on the integrations page.',
          icon: app.id === 'hubspot' ? 'Database01' : 'Grid01',
          hasBadge: true,
          badge: status,
          badgeBg: tone.bg,
          badgeFg: tone.fg,
          canDel: false,
          run: () => {
            setAddOpen(false);
            setAddPane(null);
            onOpenIntegrations();
          },
        };
      }),
    [managedApps?.apps, onOpenIntegrations],
  );

  const libraryReasoningItems = useMemo<MeriLibraryPaneItem[]>(
    () =>
      MERI_REASONING_MODES.map((mode) => ({
        key: mode.mode,
        label: mode.mode === 'standard' ? `${mode.label} (default)` : mode.label,
        desc: mode.description,
        icon: 'Speedometer03',
        hasBadge: mode.mode === reasoningMode,
        badge: 'CURRENT',
        badgeBg: '#F2F4F7',
        badgeFg: '#475467',
        canDel: false,
        disabled: reasoningSaving,
        run: () => {
          if (reasoningSaving) return;
          void setReasoningMode(mode.mode);
          setAddOpen(false);
          setAddPane(null);
        },
      })),
    [reasoningMode, reasoningSaving, setReasoningMode],
  );

  const LIBRARY_PANES: Array<{
    id: MeriLibraryPaneId;
    label: string;
    desc: string;
    icon: MeriIconName;
    count: string;
    items: MeriLibraryPaneItem[];
    emptyText: string;
    foot: string;
  }> = [
    {
      id: 'prompts',
      label: 'Saved prompts',
      desc: 'FILLS THE COMPOSER · NEVER SENDS',
      icon: 'Bookmark',
      count: String(promptsQuery.data?.length ?? 0),
      items: libraryPromptItems,
      emptyText: 'No saved prompts yet. Save one from a message you liked.',
      foot: 'A SAVED PROMPT FILLS THE COMPOSER — IT NEVER AUTO-SENDS',
    },
    {
      id: 'skills',
      label: 'Skills',
      desc: 'A ROUTINE MERI ALREADY KNOWS',
      icon: 'MagicWand02',
      count: String(startWorkCatalog.skills.length),
      items: librarySkillItems,
      emptyText: 'No skills yet. Ask Meri to turn a routine into one.',
      foot: 'SKILLS FILL THE COMPOSER — THEY NEVER AUTO-SEND',
    },
    {
      id: 'connectors',
      label: 'Connectors',
      desc: 'MANAGE CONNECTED SOURCES',
      icon: 'Dataflow03',
      count: String(managedApps?.apps.length ?? 0),
      items: libraryConnectorItems,
      emptyText: 'No connectors available.',
      foot: 'HUBSPOT AND AIRTABLE ARE THE ONLY MANAGED APPS TODAY',
    },
    {
      id: 'reasoning',
      label: 'Reasoning',
      desc: 'HOW DEEPLY MERI THINKS',
      icon: 'Speedometer03',
      count: currentReasoning.label.toUpperCase(),
      items: libraryReasoningItems,
      emptyText: '',
      foot: activeConversationId
        ? 'SAVED TO THIS CONVERSATION'
        : 'HELD FOR THIS DRAFT AND APPLIED WHEN THE THREAD IS CREATED',
    },
  ];
  const activePane = addPane ? (LIBRARY_PANES.find((pane) => pane.id === addPane) ?? null) : null;

  const uploadsInFlight = stagedAttachments.some((attachment) => attachment.status === 'uploading');
  const busy = isStreaming || submitting;
  // Unified send gate: route/session ownership and first-send ownership are
  // enforced inside the send path. This predicate covers the remaining
  // durable-transition gate (scope persistence). Both the Send button and
  // the keyboard path (Enter / Cmd+Enter) use this same predicate.
  const canSend = maySend(busy, scopePersistStatus) && !uploadsInFlight && !reasoningSaving;
  // v6: the quiet "Context" label (with attachment count when files are
  // staged). Client scope is carried by the top-bar scope chip, not repeated
  // here per the prototype.
  const contextLabel = stagedAttachments.length
    ? `Context · ${stagedAttachments.length} attached`
    : 'Context';

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
  }, [setDraft]);

  const workspaceRequest = useCallback(
    async (path: string) => {
      const { data } = await api.get(path);
      return data as unknown;
    },
    [api],
  );

  // Every chooser response belongs to its originating identity AND thread.
  // Switching routes closes it before paint; delayed results cannot fill the
  // new thread, including after navigating away and back to the same thread.
  const previousWorkspaceScopeRef = useRef(workspaceScopeKey);
  useLayoutEffect(() => {
    if (previousWorkspaceScopeRef.current === workspaceScopeKey) return;
    previousWorkspaceScopeRef.current = workspaceScopeKey;
    closeWorkspaceImport();
    setWorkspaceDrafts([]);
    setWorkspaceDocuments({});
    setWorkspaceExpanded({});
    setWorkspaceDraftLoading({});
    setWorkspaceDocumentLoading({});
    workspaceDraftRequestsRef.current.clear();
    workspaceDocumentRequestsRef.current.clear();
    setWorkspaceImportError(null);
    setWorkspaceImportLoading(false);
  }, [workspaceScopeKey, closeWorkspaceImport]);

  useEffect(() => {
    if (!workspaceImportOpen) return;
    const epoch = ++workspaceRequestEpochRef.current;
    workspaceDraftRequestsRef.current.clear();
    workspaceDocumentRequestsRef.current.clear();
    setWorkspaceDrafts([]);
    setWorkspaceDocuments({});
    setWorkspaceExpanded({});
    setWorkspaceDraftLoading({});
    setWorkspaceDocumentLoading({});
    setWorkspaceImportLoading(true);
    setWorkspaceImportError(null);
    void workspaceRequest('/workspace-api/drafts?scope=all')
      .then((data) => {
        if (!mayApplyWorkspaceRequest(epoch)) return;
        setWorkspaceDrafts(workspaceImportDraftsResponse(data));
      })
      .catch(() => {
        if (mayApplyWorkspaceRequest(epoch)) {
          setWorkspaceDrafts([]);
          setWorkspaceImportError('Workspace documents could not be loaded.');
        }
      })
      .finally(() => {
        if (mayApplyWorkspaceRequest(epoch)) {
          setWorkspaceImportLoading(false);
        }
      });
    return () => {
      workspaceRequestEpochRef.current += 1;
    };
  }, [workspaceScopeKey, workspaceImportOpen, workspaceRequest, mayApplyWorkspaceRequest]);

  const loadWorkspaceDocument = useCallback(
    async (draftId: string, documentId: string) => {
      const epoch = workspaceRequestEpochRef.current;
      const requestKey = JSON.stringify([draftId, documentId]);
      if (workspaceDocumentRequestsRef.current.has(requestKey)) return;
      workspaceDocumentRequestsRef.current.add(requestKey);
      setWorkspaceDocumentLoading((current) => ({ ...current, [requestKey]: true }));
      setWorkspaceImportError(null);
      try {
        const data = await workspaceRequest(
          `/workspace-api/drafts/${encodeURIComponent(draftId)}/documents/${encodeURIComponent(documentId)}/meri-import`,
        );
        if (!mayApplyWorkspaceRequest(epoch)) return;
        const composerText = workspaceDocumentComposerText(data);
        if (!composerText) {
          setWorkspaceImportError('This workspace document has no readable text.');
          return;
        }
        setDraft((current) =>
          current.trim() ? `${current.trim()}\n\n${composerText}` : composerText,
        );
        closeWorkspaceImport();
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      } catch {
        if (mayApplyWorkspaceRequest(epoch)) {
          setWorkspaceImportError('The workspace document could not be loaded.');
        }
      } finally {
        if (mayApplyWorkspaceRequest(epoch)) {
          workspaceDocumentRequestsRef.current.delete(requestKey);
          setWorkspaceDocumentLoading((current) => ({ ...current, [requestKey]: false }));
        }
      }
    },
    [workspaceRequest, mayApplyWorkspaceRequest, closeWorkspaceImport, setDraft],
  );

  const loadWorkspaceDraftDocuments = useCallback(
    async (draftId: string) => {
      if (workspaceExpanded[draftId]) {
        setWorkspaceExpanded((current) => ({ ...current, [draftId]: false }));
        return;
      }
      setWorkspaceExpanded((current) => ({ ...current, [draftId]: true }));
      if (
        workspaceDocuments[draftId] !== undefined ||
        workspaceDraftRequestsRef.current.has(draftId)
      )
        return;
      const epoch = workspaceRequestEpochRef.current;
      workspaceDraftRequestsRef.current.add(draftId);
      setWorkspaceDraftLoading((current) => ({ ...current, [draftId]: true }));
      setWorkspaceImportError(null);
      try {
        const data = await workspaceRequest(
          `/workspace-api/drafts/${encodeURIComponent(draftId)}/documents/meri-import`,
        );
        if (!mayApplyWorkspaceRequest(epoch)) return;
        const documents = workspaceImportDocumentsResponse(data);
        setWorkspaceDocuments((current) => ({ ...current, [draftId]: documents }));
        if (!documents.length)
          setWorkspaceImportError('This workspace draft has no readable documents.');
      } catch {
        if (mayApplyWorkspaceRequest(epoch)) {
          setWorkspaceExpanded((current) => ({ ...current, [draftId]: false }));
          setWorkspaceImportError('The workspace draft could not be loaded.');
        }
      } finally {
        if (mayApplyWorkspaceRequest(epoch)) {
          workspaceDraftRequestsRef.current.delete(draftId);
          setWorkspaceDraftLoading((current) => ({ ...current, [draftId]: false }));
        }
      }
    },
    [workspaceDocuments, workspaceExpanded, workspaceRequest, mayApplyWorkspaceRequest],
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

  // The pane view is transient to the open popover — reopening the add menu
  // always starts at the LIBRARY root, matching the prototype's `addPane:
  // null` reset on `toggleAdd`.
  useEffect(() => {
    if (!addOpen) setAddPane(null);
  }, [addOpen]);

  const submit = useCallback(
    async (forced?: string) => {
      const content = (forced ?? draft).trim();
      // Unified send gate: same predicate as the Send button and keyboard path.
      if (!maySend(busy, scopePersistStatus) || uploadsInFlight || reasoningSaving) return;
      if (!content) {
        toast.success('Write a message, then press Send.');
        return;
      }

      // Clear optimistically so accepted messages feel immediate, but restore
      // the exact text when route-level creation rejects the send. The old
      // composer discarded the user's first prompt even when no thread existed.
      setSubmitting(true);
      const restoreDraft = clearForSubmission();
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      try {
        const accepted = await sendMessage(content);
        if (accepted === false) restoreDraft();
      } catch {
        restoreDraft();
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      } finally {
        setSubmitting(false);
      }
    },
    [
      busy,
      draft,
      sendMessage,
      toast,
      uploadsInFlight,
      reasoningSaving,
      scopePersistStatus,
      clearForSubmission,
    ],
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
    <div
      className={`vnext-meri__composer-wrap${dragActive ? ' is-drag-active' : ''}`}
      ref={addRef}
      onDragEnter={(event) => {
        event.preventDefault();
        dragCounterRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        // Required for onDrop to fire — browsers cancel drop by default.
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragCounterRef.current = 0;
        setDragActive(false);
        if (busy) return;
        if (event.dataTransfer.files?.length) handleAttachFiles(event.dataTransfer.files);
      }}
    >
      {dragActive ? (
        <div className="vnext-meri__composer-dropzone" aria-hidden="true">
          <MeriIcon name="UploadCloud02" size={20} color="#475467" />
          <span>Drop files to attach — any file type</span>
        </div>
      ) : null}
      {addOpen ? (
        <div className="vnext-meri__add-popover" role="menu" aria-label="Add to conversation">
          {!activePane ? (
            <>
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
                  <MeriIcon name="Plus" size={13} color="var(--m-gray-600)" />
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
                  <MeriIcon name="Edit01" size={13} color="var(--m-gray-600)" />
                </span>
                <span className="vnext-meri__add-popover-item-body">
                  <span className="vnext-meri__add-popover-item-label">Add note</span>
                  <span className="vnext-meri__add-popover-item-desc">
                    ADDS EDITABLE TEXT TO THIS MESSAGE
                  </span>
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
                  <ConnectorMark id="hubspot" size={15} />
                </span>
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
                  toast.error(
                    'SharePoint is not connectable yet. Open Integrations to see supported sources.',
                  );
                  onOpenIntegrations();
                }}
                aria-label="Connect SharePoint — not connectable yet"
              >
                <span className="vnext-meri__add-popover-tile">
                  <ConnectorMark id="sharepoint" size={15} />
                </span>
                <span className="vnext-meri__add-popover-item-body">
                  <span className="vnext-meri__add-popover-item-label">Connect SharePoint</span>
                  <span className="vnext-meri__add-popover-item-desc">NOT CONNECTABLE YET</span>
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
                  <ConnectorMark id="airtable" size={15} />
                </span>
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
                  <MeriIcon name="LayersThree01" size={13} color="var(--m-gray-600)" />
                </span>
                <span className="vnext-meri__add-popover-item-body">
                  <span className="vnext-meri__add-popover-item-label">Import from workspace</span>
                  <span className="vnext-meri__add-popover-item-desc">
                    REVIEW A DOCUMENT BEFORE ADDING IT TO THE DRAFT
                  </span>
                </span>
              </button>

              <div className="vnext-meri__add-popover-separator" />
              <div className="vnext-meri__add-popover-eyebrow">LIBRARY</div>
              {LIBRARY_PANES.map((pane) => (
                <button
                  key={pane.id}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  className="vnext-meri__add-popover-pane-trigger"
                  onClick={() => setAddPane(pane.id)}
                >
                  <span className="vnext-meri__add-popover-tile">
                    <MeriIcon name={pane.icon} size={15} color="var(--m-gray-600)" />
                  </span>
                  <span className="vnext-meri__add-popover-item-body">
                    <span className="vnext-meri__add-popover-item-label">{pane.label}</span>
                    <span className="vnext-meri__add-popover-item-desc">{pane.desc}</span>
                  </span>
                  <span className="vnext-meri__add-popover-pane-meta">
                    <span className="vnext-meri__add-popover-pane-count">{pane.count}</span>
                    <MeriIcon name="ChevronRight" size={14} color="#98A2B3" />
                  </span>
                </button>
              ))}

              <div className="vnext-meri__add-popover-separator" />
              <div className="vnext-meri__add-popover-footer">
                EVERYTHING ADDED HERE IS SCOPED TO THIS THREAD AND LOGGED
              </div>
            </>
          ) : (
            <>
              <div className="vnext-meri__add-popover-pane-head">
                <button
                  type="button"
                  aria-label="Back to add menu"
                  className="vnext-meri__add-popover-pane-back"
                  onClick={() => setAddPane(null)}
                >
                  <MeriIcon name="ChevronLeft" size={15} color="#667085" />
                </button>
                <span className="vnext-meri__add-popover-eyebrow">
                  {activePane.label.toUpperCase()}
                </span>
              </div>
              <div className="vnext-meri__add-popover-pane-body">
                {activePane.items.map((item) => (
                  <div key={item.key} className="vnext-meri__add-popover-pane-row">
                    <button
                      type="button"
                      role="menuitem"
                      className="vnext-meri__add-popover-pane-item"
                      onClick={item.run}
                      disabled={item.disabled}
                    >
                      <span className="vnext-meri__add-popover-tile">
                        <MeriIcon name={item.icon} size={15} color="var(--m-gray-600)" />
                      </span>
                      <span className="vnext-meri__add-popover-item-body">
                        <span className="vnext-meri__add-popover-item-label">{item.label}</span>
                        <span
                          className="vnext-meri__add-popover-item-desc"
                          style={item.descFg ? { color: item.descFg } : undefined}
                        >
                          {item.desc}
                        </span>
                      </span>
                      {item.hasBadge ? (
                        <span
                          className="vnext-meri__add-popover-pane-badge"
                          style={{ background: item.badgeBg, color: item.badgeFg }}
                        >
                          {item.badge}
                        </span>
                      ) : null}
                    </button>
                    {item.canDel ? (
                      <button
                        type="button"
                        aria-label={item.delLabel}
                        className="vnext-meri__add-popover-pane-del"
                        onClick={item.del}
                      >
                        <MeriIcon name="Trash01" size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              {activePane.items.length === 0 ? (
                <div className="vnext-meri__add-popover-pane-empty">{activePane.emptyText}</div>
              ) : null}
              <div className="vnext-meri__add-popover-separator" />
              <div className="vnext-meri__add-popover-footer">{activePane.foot}</div>
            </>
          )}
        </div>
      ) : null}

      {reasoningError ? (
        <div className="vnext-meri__reasoning-error" role="alert">
          {reasoningError}
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

      <div
        className={`vnext-meri__composer${focused ? ' is-focused' : ''}${draft.trim() ? ' has-draft' : ''}`}
      >
        {/*
          v5 workspace mockup: the textarea spans the full composer width on
          its own row; the "Add to conversation" trigger lives in the toolbar
          row below, not beside the textarea. Moved rather than duplicated —
          same button, same handler, same popover (still anchored to
          .vnext-meri__composer-wrap so its position is unaffected).
        */}
        {stagedAttachments.length > 0 ? (
          <div className="vnext-meri__attachments" aria-label="Attached files">
            {stagedAttachments.map((attachment) => {
              const failed = stagedAttachmentFailed(attachment);
              const truncated = attachment.status === 'truncated';
              return (
                <span
                  key={attachment.localId}
                  className={`vnext-meri__attachment${failed ? ' is-error' : truncated ? ' is-truncated' : ' is-ready'}`}
                >
                  <span
                    aria-hidden="true"
                    style={{ display: 'flex', color: failed ? '#B42318' : '#98A2B3' }}
                  >
                    <MeriIcon name={stagedAttachmentIconName(attachment.kind)} size={14} />
                  </span>
                  <span title={attachment.filename} className="vnext-meri__attachment-name">
                    {truncateFilenameMiddle(attachment.filename, 28)}
                  </span>
                  <span className="vnext-meri__attachment-state">
                    {attachment.status === 'uploading'
                      ? 'UPLOADING'
                      : failed
                        ? 'UNAVAILABLE'
                        : truncated
                          ? 'TRUNCATED'
                          : 'READY'}
                  </span>
                  <button
                    type="button"
                    className="vnext-meri__attachment-remove"
                    onClick={() => removeStagedAttachment(attachment.localId)}
                    aria-label={`Remove ${attachment.filename}`}
                  >
                    <MeriIcon name="XClose" size={12} />
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

          <button
            type="button"
            className="vnext-meri__composer-context-label"
            onClick={() => setAddOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            title="Add context to this thread"
          >
            <MeriIcon name="Attachment01" size={13} />
            <span className="vnext-meri__composer-context-text">{contextLabel}</span>
          </button>

          <span
            className="vnext-meri__composer-send-hint"
            style={{
              color: isStreaming
                ? '#B42318'
                : scopePersistStatus === 'saving'
                  ? '#B54708'
                  : scopePersistStatus === 'error'
                    ? '#B42318'
                    : submitting
                      ? '#667085'
                      : '#98A2B3',
            }}
          >
            {isStreaming
              ? 'STOP'
              : scopePersistStatus === 'saving'
                ? 'SAVING CLIENT SCOPE…'
                : scopePersistStatus === 'error'
                  ? 'SCOPE ERROR'
                  : reasoningSaving
                    ? 'SAVING REASONING…'
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
              <MeriIcon name="StopCircle" size={16} color="#B42318" />
            </button>
          ) : (
            <button
              type="button"
              className={`vnext-meri__composer-send-btn${draft.trim() ? ' is-ready' : ' is-empty'}`}
              disabled={!canSend}
              onClick={() => void submit()}
              aria-label="Send"
            >
              <MeriIcon name="Send01" size={17} color={draft.trim() ? '#FFFFFF' : '#98A2B3'} />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  const workspaceImportDialog = workspaceImportOpen ? (
    <div
      className="vnext-meri__confirm-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeWorkspaceImport();
      }}
    >
      <div
        ref={workspaceDialogRef}
        tabIndex={-1}
        className="vnext-meri__confirm-dialog vnext-meri__workspace-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meri-workspace-import-title"
        aria-describedby="meri-workspace-import-description"
      >
        <div id="meri-workspace-import-title" className="vnext-meri__confirm-title">
          Import from workspace
        </div>
        <div id="meri-workspace-import-description" className="vnext-meri__confirm-body">
          Select a document to add as editable text. It stays in this draft until you review and
          send it.
        </div>
        {workspaceImportLoading ? (
          <div className="vnext-meri__ctx-empty">Loading workspace documents…</div>
        ) : null}
        {workspaceImportError ? (
          <div className="vnext-meri__ctx-empty">{workspaceImportError}</div>
        ) : null}
        {!workspaceImportLoading && !workspaceImportError && workspaceDrafts.length === 0 ? (
          <div className="vnext-meri__ctx-empty">No workspace documents are available.</div>
        ) : null}
        <div className="vnext-meri__move-workspace-list">
          {workspaceDrafts.map((workspaceDraft) => {
            const documents = workspaceExpanded[workspaceDraft.id]
              ? workspaceDocuments[workspaceDraft.id]
              : undefined;
            const loading = workspaceDraftLoading[workspaceDraft.id];
            return (
              <div key={workspaceDraft.id} className="vnext-meri__workspace-draft">
                <button
                  type="button"
                  className="vnext-meri__workspace-item"
                  onClick={() => void loadWorkspaceDraftDocuments(workspaceDraft.id)}
                  aria-expanded={Boolean(workspaceExpanded[workspaceDraft.id])}
                >
                  <span className="vnext-meri__workspace-copy">
                    <span className="vnext-meri__workspace-name">{workspaceDraft.docTitle}</span>
                    <span className="vnext-meri__workspace-meta">
                      {workspaceDraft.clientName ?? 'Workspace draft'}
                    </span>
                  </span>
                  <span className="vnext-meri__workspace-meta">
                    {loading ? 'LOADING…' : 'VIEW DOCUMENTS'}
                  </span>
                </button>
                {documents?.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    className="vnext-meri__workspace-item vnext-meri__workspace-document"
                    disabled={
                      workspaceDocumentLoading[JSON.stringify([workspaceDraft.id, document.id])]
                    }
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
            onClick={closeWorkspaceImport}
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
