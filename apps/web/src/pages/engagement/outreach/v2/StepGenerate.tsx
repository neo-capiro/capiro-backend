// Step 6 — Generate & Review (board step 10).
//
// Entity-aware drafting over the Outreach 2.0 target model:
//   • Individual — one personalized draft each (blue).
//   • List — one draft PER MEMBER; the list card expands to each member's
//     own draft, and editing one member offers "Apply to all in list" (green).
//   • Group — ONE shared draft for the whole group (amber).
//
// The left rail shows a "N / N ready" drafts pill + one card per entity. The
// editor pane has the entity badge + name + context line, a tone control,
// Regenerate this / Regenerate all, a Subject field, and the WYSIWYG body
// editor. The campaign-level Attachments picker (production feature) lives
// below the editor. Generation/keying live in the shell + generation.ts; this
// component is the presentation + interaction layer.
//
// Presentation rebuilt onto Tailwind + React Aria per the real migration
// (handover §0, §6.9) — every handler, query, and piece of state below is
// unchanged. Two things deliberately were NOT changed to match the handover
// literally, because doing so would have changed behavior (out of scope —
// "no functionality should change except the step split"):
//   - The handover describes "Improve" as a collapsible disclosure with
//     canned suggestion chips and separate Rewrite/Cancel actions. The real
//     component has always been a single always-visible instruction field +
//     "Improve" button wired straight to `onImprove` — that's what's kept.
//   - ContextUsedPanel and DraftVersionCompare are separate, already-tested
//     components rendered inside this step; they are NOT rebuilt here (out
//     of this step's scope) and still render with their existing antd/--ov2-*
//     styling.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { GeneratedDraft, WizardV2State } from './types.js';
import { ContextUsedPanel } from './ContextUsedPanel.js';
import {
  DRAFT_BLOCK_COPY,
  draftBlockReason,
  isDraftSendable,
  isVersioned,
  type DraftCandidate,
} from './versioned-drafts.js';
import { listAidFromKey, type GenSlot, type RailEntity, type RailSlot } from './generation.js';
import { RichTextEditor } from './RichTextEditor.js';
import { DraftVersionCompare } from './DraftVersionCompare.js';
// RichTextEditor (unchanged, out of this step's scope) has no CSS import of
// its own — it relies on whichever parent loads step-generate.css for its
// `.ov2-rte-*` classes. This file used to be that parent; keep the import so
// the editor doesn't silently render unstyled now that the rest of this
// component no longer uses step-generate.css for anything else.
import './step-generate.css';
import './ui/tailwind.css';
import { Icon } from './ui/icons.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { Select } from './ui/Select.js';
import { Checkbox } from './ui/Checkbox.js';
import { Dialog } from './ui/Dialog.js';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../clients/clientTypes.js';

interface AttachmentDoc {
  id: string;
  fileName: string;
  contentType: string;
  clientId?: string;
  clientName?: string;
  folder?: string | null;
  size?: string | null;
  date?: string | null;
  createdAt?: string | null;
  byteSize?: number | null;
}

function attachmentDate(document?: Pick<AttachmentDoc, 'date' | 'createdAt'>): string | null {
  const value = document?.date ?? document?.createdAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function attachmentTypeLabel(document?: Pick<AttachmentDoc, 'fileName' | 'contentType'>): string {
  const extension = document?.fileName.split('.').pop()?.trim();
  if (extension && extension !== document?.fileName) return extension.toUpperCase();
  return document?.contentType.split('/').at(-1)?.replace('vnd.openxmlformats-officedocument.', '').toUpperCase() || 'FILE';
}

interface Props {
  entities: RailEntity[];
  slots: GenSlot[];
  generated: WizardV2State['generatedEmails'];
  tone: WizardV2State['tone'];
  onTone: (t: WizardV2State['tone']) => void;
  selectedKey: string | null;
  onSelectKey: (key: string) => void;
  onRegenerateAll: () => void;
  onRegenerateOne: (genKey: string) => void;
  /** "Improve": revise the named draft in place per a freeform instruction. */
  onImprove: (genKey: string, instruction: string) => void;
  /** Revert the last "Improve" on the named draft. */
  onRevert: (genKey: string) => void;
  /** Decide a held draft's review in place, without going to the Reviews queue. */
  onApproveHeld?: (genKey: string) => void;
  onRejectHeld?: (genKey: string) => void;
  /** Draft whose review decision is in flight. */
  decidingKey?: string | null;
  /** Context (or template/tone) changed since these drafts were generated. */
  contextStale?: boolean;
  /**
   * Phase 2 §3.f1 — the precise slots the current stale context touches,
   * with why. Empty/undefined when nothing is affected (nothing to show)
   * or `contextStale` covers exactly this same information less precisely.
   */
  affectedGenKeys?: string[];
  affectedReasonsByKey?: Record<string, string[]>;
  onRegenerateAffected?: () => void;
  /**
   * Phase 2 §3.f2/f3 — regenerations the server refused to apply directly
   * because the slot's current draft was manually authored. Rendered as
   * compare/merge cards; the current draft is untouched until resolved.
   */
  candidates?: DraftCandidate[];
  onKeepMineCandidate?: (genKey: string) => void;
  onAcceptCandidate?: (candidate: DraftCandidate) => void | Promise<void>;
  onMergeCandidate?: (candidate: DraftCandidate, subject: string, body: string) => void | Promise<void>;
  candidateBusyKey?: string | null;
  onEdit: (genKey: string, patch: { subject?: string; body?: string }) => void;
  onApplyToList: (listAid: string, sourceKey: string) => void;
  regenerating: boolean;
  generatingKey: string | null;
  // Attachments (campaign-level; preserved from production).
  clientId: string | null;
  clients: Client[];
  docs: AttachmentDoc[];
  attachmentIds: string[];
  onToggleAttachment: (id: string) => void;
  onUploadAttachment: (file: File) => void;
}

const KIND_BADGE: Record<RailEntity['kind'], { label: string; icon: typeof Icon.User01 }> = {
  individual: { label: 'Individual', icon: Icon.User01 },
  list: { label: 'List', icon: Icon.LayoutAlt01 },
  group: { label: 'Group', icon: Icon.Users01 },
};

const TONE_OPTIONS = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
  { value: 'concise', label: 'Concise' },
];

/**
 * Phase 0 (§3.g5) — readiness comes from the SERVER lifecycle, via the one shared
 * gate. The old local check treated 'edited' as ready, which meant typing a
 * character into a held or failed draft marked it ready in the rail and let it
 * through the send projection.
 */
function isReady(draft?: GeneratedDraft): boolean {
  return isDraftSendable(draft);
}

/** Per-state banner for the active draft. Held is never shown as "failed". */
function draftBanner(draft: GeneratedDraft | undefined): {
  type: 'warning' | 'error' | 'info';
  message: string;
  description: string;
} | null {
  const reason = draftBlockReason(draft);
  if (!reason) return null;
  switch (reason) {
    case 'held':
      return {
        type: 'warning',
        message: 'Held for review',
        description: DRAFT_BLOCK_COPY.held,
      };
    case 'unavailable':
      return {
        type: 'error',
        message: 'Verification unavailable',
        description: DRAFT_BLOCK_COPY.unavailable,
      };
    case 'pending':
      return {
        type: 'info',
        message: 'Verification in progress',
        description: DRAFT_BLOCK_COPY.pending,
      };
    case 'rejected':
      return {
        type: 'error',
        message: 'Rejected by a reviewer',
        description: DRAFT_BLOCK_COPY.rejected,
      };
    case 'awaiting_review':
      return {
        type: 'warning',
        message: 'Pending review',
        description: DRAFT_BLOCK_COPY.awaiting_review,
      };
    case 'source_failure':
      return {
        type: 'error',
        message: 'Missing required context',
        description: DRAFT_BLOCK_COPY.source_failure,
      };
    case 'dirty':
      return { type: 'info', message: 'Unsaved changes', description: DRAFT_BLOCK_COPY.dirty };
    case 'generation_failed':
      return {
        type: 'warning',
        message: "This draft couldn't be generated",
        // The server's reason (e.g. a plan-validator rejection such as "…messages
        // carry one ask; the plan has 3") is the actionable part. Before
        // 2026-09-03 the placeholder banner never showed it, so a campaign where
        // 4 of 5 drafts were rejected for the same reason gave the user nothing
        // to fix. Falls back to the generic line when no reason was recorded.
        description: draft?.failureReason
          ? `${draft.failureReason} It will not be sent as-is — edit the text below or click "Regenerate this".`
          : 'It will not be sent as-is. Edit the text below, or click "Regenerate this" to try again.',
      };
    case 'missing':
    default:
      return null;
  }
}

export function StepGenerate({
  entities,
  slots,
  generated,
  tone,
  onTone,
  selectedKey,
  onSelectKey,
  onRegenerateAll,
  onRegenerateOne,
  onImprove,
  onRevert,
  onApproveHeld,
  onRejectHeld,
  decidingKey,
  contextStale,
  affectedGenKeys,
  affectedReasonsByKey,
  onRegenerateAffected,
  candidates,
  onKeepMineCandidate,
  onAcceptCandidate,
  onMergeCandidate,
  candidateBusyKey,
  onEdit,
  onApplyToList,
  regenerating,
  generatingKey,
  clientId,
  clients,
  docs,
  attachmentIds,
  onToggleAttachment,
  onUploadAttachment,
}: Props) {
  // Lists default to expanded so members are visible (board shows them open).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The list-member draft just edited — drives the green propagation banner.
  const [bannerFor, setBannerFor] = useState<string | null>(null);
  // Freeform "Improve" instruction for the active draft (cleared on switch/submit).
  const [improveText, setImproveText] = useState('');
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesClientId, setFilesClientId] = useState(clientId ?? '__general__');
  const [filesSearch, setFilesSearch] = useState('');
  const [pendingFileIds, setPendingFileIds] = useState<string[]>(attachmentIds);
  const [fileDetails, setFileDetails] = useState<Record<string, AttachmentDoc>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const api = useApi();

  const clientFilesQuery = useQuery({
    queryKey: ['outreach-attachment-client-files', filesClientId],
    enabled: filesOpen && Boolean(filesClientId) && filesClientId !== '__general__',
    queryFn: async () => (await api.get<AttachmentDoc[]>('/api/engagement/attachments', {
      params: { clientId: filesClientId },
    })).data,
    retry: false,
    staleTime: 60_000,
  });
  const fileClient = clients.find((client) => client.id === filesClientId) ?? null;
  const filesForClient = filesClientId === clientId || filesClientId === '__general__' ? docs : (clientFilesQuery.data ?? []);
  const filteredClientFiles = filesForClient.filter((document) =>
    !filesSearch.trim() || document.fileName.toLocaleLowerCase().includes(filesSearch.trim().toLocaleLowerCase()),
  );

  useEffect(() => {
    const loadedFiles = [...docs, ...(clientFilesQuery.data ?? [])];
    if (loadedFiles.length) {
      setFileDetails((current) => ({
        ...current,
        ...Object.fromEntries(loadedFiles.map((document) => [document.id, {
          ...document,
          clientName: document.clientName ?? clients.find((client) => client.id === document.clientId)?.name,
        }])),
      }));
    }
  }, [clients, docs, clientFilesQuery.data]);

  const openFiles = () => {
    const preferredClient = clientId ?? '__general__';
    setFilesClientId(preferredClient);
    setFilesSearch('');
    setPendingFileIds(attachmentIds);
    setFilesOpen(true);
  };

  const saveFiles = () => {
    const allChangedIds = new Set([...attachmentIds, ...pendingFileIds]);
    for (const id of allChangedIds) {
      const wasAttached = attachmentIds.includes(id);
      const shouldAttach = pendingFileIds.includes(id);
      if (wasAttached !== shouldAttach) onToggleAttachment(id);
    }
    setFileDetails((current) => ({
      ...current,
      ...Object.fromEntries(filesForClient.map((document) => [document.id, {
        ...document,
        clientId: document.clientId ?? filesClientId,
        clientName: document.clientName ?? fileClient?.name,
      }])),
    }));
    setFilesOpen(false);
  };

  // Flat lookup: genKey → { entity, slot }.
  const index = useMemo(() => {
    const map = new Map<string, { entity: RailEntity; slot: RailSlot }>();
    for (const entity of entities) {
      for (const slot of entity.members) map.set(slot.genKey, { entity, slot });
    }
    return map;
  }, [entities]);

  const allKeys = useMemo(
    () => entities.flatMap((e) => e.members.map((m) => m.genKey)),
    [entities],
  );
  const activeKey = selectedKey && index.has(selectedKey) ? selectedKey : (allKeys[0] ?? null);
  const active = activeKey ? index.get(activeKey) : undefined;
  const activeDraft = activeKey ? generated[activeKey] : undefined;

  const total = slots.length;
  const ready = slots.filter((s) => isReady(generated[s.genKey])).length;
  const batchGenerating = regenerating && !generatingKey;
  const affectedCount = affectedGenKeys?.length ?? 0;
  // Only worth its own button when it's a real subset — regenerating
  // "affected" when that's everyone is just Regenerate all with extra steps.
  const showAffectedButton = affectedCount > 0 && affectedCount < total && onRegenerateAffected;
  const affectedReasons = affectedGenKeys?.length
    ? Array.from(new Set(affectedGenKeys.flatMap((k) => affectedReasonsByKey?.[k] ?? [])))
    : [];

  const select = (key: string) => {
    if (key !== activeKey) {
      setBannerFor(null);
      setImproveText('');
    }
    onSelectKey(key);
  };

  const submitImprove = () => {
    if (!activeKey || !improveText.trim()) return;
    onImprove(activeKey, improveText);
    setImproveText('');
  };

  const editActive = (patch: { subject?: string; body?: string }) => {
    if (!activeKey) return;
    onEdit(activeKey, patch);
    if (active?.slot.appliesTo === 'member') setBannerFor(activeKey);
  };

  // A regenerate flips the draft back to 'ready'; clear any stale "you edited
  // this" banner so "Apply to all in list" can't push un-edited content.
  useEffect(() => {
    if (bannerFor && generated[bannerFor]?.status === 'ready') setBannerFor(null);
  }, [bannerFor, generated]);

  if (entities.length === 0) {
    return (
      <div className="ov2-tw-root">
        <h2 className="text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
          Generate &amp; review
        </h2>
        <div className="mt-1.5 text-sm leading-5 text-ink-secondary">
          Add recipients first, then come back to draft their emails.
        </div>
      </div>
    );
  }

  return (
    <div className="ov2-tw-root">
      <h2 className="text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
        Generate &amp; review
      </h2>
      <div className="mt-1.5 mb-5 text-sm leading-5 text-ink-secondary">
        Meri drafts a unique email for each individual and list member, and one shared email per
        group. Edit any draft inline, regenerate, or save everything as a draft to finish later.
      </div>

      {contextStale && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-warning-bg p-3"
        >
          <span className="flex-none text-warning-heading">
            <Icon.Zap size={16} />
          </span>
          <span className="flex-1 text-[13px] leading-5 text-warning">
            Your context changed since these drafts were generated
            {showAffectedButton ? (
              <>
                {' '}
                — {affectedCount} of {total} draft{affectedCount === 1 ? '' : 's'} affected
                {affectedReasons.length ? `: ${affectedReasons.slice(0, 3).join('; ')}` : ''}.
              </>
            ) : (
              <>
                {' '}
                . Regenerate to apply it <em>(this replaces every draft, including any manual edits)</em>.
              </>
            )}
          </span>
          {showAffectedButton && (
            <Button variant="secondary" size="sm" onPress={onRegenerateAffected} isDisabled={batchGenerating}>
              {batchGenerating ? 'Regenerating…' : `Regenerate affected (${affectedCount})`}
            </Button>
          )}
          <Button variant="secondary" size="sm" onPress={onRegenerateAll} isDisabled={batchGenerating}>
            {batchGenerating ? 'Regenerating…' : 'Regenerate all'}
          </Button>
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <>
          {candidates.map((c) => {
            const slotInfo = index.get(c.genKey);
            const currentDraft = generated[c.genKey];
            return (
              <DraftVersionCompare
                key={c.genKey}
                candidate={c}
                slotName={slotInfo?.slot.name ?? c.genKey}
                current={{ subject: currentDraft?.subject ?? '', body: currentDraft?.body ?? '' }}
                busy={candidateBusyKey === c.genKey}
                onKeepMine={() => onKeepMineCandidate?.(c.genKey)}
                onAccept={() => onAcceptCandidate?.(c)}
                onMergeManually={(subject, body) => onMergeCandidate?.(c, subject, body)}
              />
            );
          })}
        </>
      )}

      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @[700px]:grid-cols-[300px_minmax(360px,1fr)]">
          {/* ---- Left rail ---- */}
          <div className="flex max-h-[640px] flex-col rounded-lg border border-line-hairline bg-surface">
            <div className="flex items-center gap-1.5 rounded-t-lg border-b border-line-hairline bg-surface-subtle px-3 py-2.5 text-[13px] font-semibold text-ink-primary">
              <Icon.Zap size={13} className="text-ink-primary" />
              {batchGenerating ? 'Generating…' : `${ready} / ${total} ready`}
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {(['individual', 'list', 'group'] as const).map((kind) => {
                const ents = entities.filter((e) => e.kind === kind);
                if (ents.length === 0) return null;
                const KindIcon = KIND_BADGE[kind].icon;
                return (
                  <div key={kind} className="mb-3 last:mb-0">
                    <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] font-bold tracking-[0.02em] text-ink-tertiary uppercase">
                      <KindIcon size={12} />
                      <span>{KIND_BADGE[kind].label}</span>
                      <span className="font-mono normal-case">{ents.length}</span>
                    </div>
                    {ents.map((entity) => (
                      <RailCard
                        key={entity.target.key}
                        entity={entity}
                        generated={generated}
                        activeKey={activeKey}
                        collapsed={collapsed.has(entity.target.key)}
                        onToggleCollapse={() =>
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(entity.target.key)) next.delete(entity.target.key);
                            else next.add(entity.target.key);
                            return next;
                          })
                        }
                        onSelect={select}
                        onRegenerateOne={onRegenerateOne}
                        generatingKey={generatingKey}
                        batchGenerating={batchGenerating}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ---- Editor pane ---- */}
          <div className="flex flex-col rounded-lg border border-line-hairline bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line-hairline pb-3">
              {active && (
                <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1 rounded-full bg-accent-tint px-2 py-0.5 text-xs font-medium text-accent-ink">
                    {(() => {
                      const ActiveKindIcon = KIND_BADGE[active.entity.kind].icon;
                      return <ActiveKindIcon size={11} />;
                    })()}{' '}
                    {KIND_BADGE[active.entity.kind].label}
                  </span>
                  <span className="text-[15px] font-semibold text-ink-primary">{active.slot.name}</span>
                  <span className="text-xs text-ink-tertiary">
                    {editorContextLine(active.entity, active.slot)}
                  </span>
                </div>
              )}
              <Select
                aria-label="Tone"
                selectedKey={tone}
                onSelectionChange={(k) => onTone(k as WizardV2State['tone'])}
                options={TONE_OPTIONS}
                height={36}
                className="w-40"
              />
              <Button
                variant="secondary"
                size="sm"
                isDisabled={!activeKey}
                onPress={() => activeKey && onRegenerateOne(activeKey)}
              >
                <Icon.Zap size={13} />
                {(!!activeKey && generatingKey === activeKey) || batchGenerating
                  ? 'Regenerating…'
                  : 'Regenerate this'}
              </Button>
              <Button variant="secondary" size="sm" onPress={onRegenerateAll}>
                <Icon.Zap size={13} />
                {batchGenerating ? 'Regenerating…' : 'Regenerate all'}
              </Button>
            </div>

            {bannerFor && bannerFor === activeKey && active?.slot.appliesTo === 'member' && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-success-border bg-success-bg p-3">
                <span className="flex-1 text-[13px] text-success">
                  <b className="font-semibold">You edited this draft.</b> Apply this change to all{' '}
                  {active.entity.members.length}{' '}
                  {active.entity.members.length === 1 ? 'member' : 'members'} in {active.entity.name}?
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onPress={() => {
                    const aid = listAidFromKey(activeKey);
                    if (aid) onApplyToList(aid, activeKey);
                    setBannerFor(null);
                  }}
                >
                  Apply to all in list
                </Button>
                <Button variant="secondary" size="sm" onPress={() => setBannerFor(null)}>
                  Save individual only
                </Button>
              </div>
            )}

            <div className="flex flex-1 flex-col">
              <DraftBanner
                banner={draftBanner(activeDraft)}
                draft={activeDraft}
                deciding={!!activeKey && decidingKey === activeKey}
                {...(activeKey && onApproveHeld
                  ? { onApprove: () => onApproveHeld(activeKey) }
                  : {})}
                {...(activeKey && onRejectHeld ? { onReject: () => onRejectHeld(activeKey) } : {})}
              />
              {activeDraft ? (
                <>
                  <div className="mb-1.5 text-[13px] font-semibold text-ink-strong">Subject</div>
                  <Input
                    value={activeDraft.subject}
                    onChange={(v) => editActive({ subject: v })}
                    placeholder="Email subject"
                    height={38}
                  />
                  <div className="mt-3.5 mb-1.5 text-[13px] font-semibold text-ink-strong">Body</div>
                  <RichTextEditor
                    value={activeDraft.body}
                    onChange={(html) => editActive({ body: html })}
                    placeholder="Write the email…"
                  />
                  <div className="mt-3.5 flex flex-col gap-1.5">
                    <div className="text-[13px] font-semibold text-ink-strong">Improve with Meri</div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <Input
                          value={improveText}
                          onChange={setImproveText}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitImprove();
                          }}
                          placeholder="e.g. make it warmer, tighten the ask, add a line about the markup"
                          disabled={!!activeKey && generatingKey === activeKey}
                        />
                      </div>
                      <Button
                        variant="primary"
                        isDisabled={!improveText.trim()}
                        onPress={submitImprove}
                      >
                        <Icon.Zap size={14} />
                        {!!activeKey && generatingKey === activeKey ? 'Improving…' : 'Improve'}
                      </Button>
                    </div>
                    {!!activeDraft.history?.length && (
                      <button
                        type="button"
                        onClick={() => activeKey && onRevert(activeKey)}
                        className="w-fit text-xs font-medium text-accent-ink hover:underline"
                      >
                        Revert last change
                      </button>
                    )}
                  </div>
                  <div className="mt-3 text-xs text-ink-tertiary">
                    Edits save automatically. Use “Save as draft” below to keep everything and finish
                    later.
                  </div>

                  {/* Phase 1 §3.j2 — what this draft was grounded in. Rendered for
                      every generated draft, not only failing ones: the point is
                      that a silently thin draft looks identical to a complete one
                      unless the provenance is always on screen. */}
                  {activeDraft.manifest ? (
                    <ContextUsedPanel
                      manifest={activeDraft.manifest}
                      {...(activeDraft.auditStatus === 'held' && activeDraft.contextNote
                        ? { heldNote: activeDraft.contextNote }
                        : {})}
                    />
                  ) : null}
                </>
              ) : (
                <div className="text-sm text-ink-tertiary">
                  {(!!activeKey && generatingKey === activeKey) || batchGenerating
                    ? 'Generating…'
                    : 'No draft yet. Click “Regenerate this”.'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Campaign attachments stay campaign-wide because the send contract has
          one attachmentIds list for the campaign. Client files are selected in
          the same modal as the prototype; upload remains available here. */}
      <div className="mt-5 rounded-lg border border-line-hairline bg-surface p-4">
        <div className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-ink-primary"><span>Attachments</span><span className="rounded-full bg-neutral-bg px-2 py-0.5 font-mono text-[10px] font-medium text-ink-secondary">{attachmentIds.length}</span></div>
        <div className="mb-3 text-sm text-ink-secondary">Files added here are attached to every email on send (max 3MB each).</div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onPress={openFiles}><Icon.Document size={13} /> Attach from client files</Button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { const files = e.target.files; if (files) Array.from(files).forEach((f) => onUploadAttachment(f)); e.target.value = ''; }} />
          <Button variant="secondary" size="sm" onPress={() => fileInputRef.current?.click()}><Icon.Plus size={13} /> Upload a file</Button>
        </div>
        {attachmentIds.length ? <div className="flex flex-col gap-2">{attachmentIds.map((id) => {
          const doc = fileDetails[id] ?? docs.find((candidate) => candidate.id === id);
          const details = [doc?.clientName, doc?.folder, doc?.size ?? (doc?.byteSize != null ? `${Math.ceil(doc.byteSize / 1024)} KB` : null), attachmentDate(doc)].filter(Boolean).join(' · ');
          const fileType = attachmentTypeLabel(doc);
          return <div key={id} className="flex items-center gap-2 rounded-lg border border-line-hairline bg-surface-subtle px-3 py-2"><span className="shrink-0 rounded bg-neutral-bg px-1.5 py-0.5 text-[9px] font-semibold text-neutral-ink">{fileType}</span><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-ink-primary">{doc?.fileName ?? 'Selected client file'}</span>{details && <span className="block truncate text-[10px] text-ink-tertiary">{details}</span>}</span><span className="shrink-0 rounded-full bg-neutral-bg px-2 py-0.5 text-[10px] text-ink-secondary">Every draft</span><button type="button" className="appearance-none border-0 bg-transparent flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-neutral-bg hover:text-ink-primary" onClick={() => onToggleAttachment(id)} aria-label={`Remove ${doc?.fileName ?? 'attachment'}`}><Icon.XClose size={13} /></button></div>;
        })}</div> : <div className="text-sm text-ink-tertiary">{clientId ? 'No stored documents for this client are attached yet.' : 'No attachments yet. Upload a file or choose one from client files.'}</div>}
      </div>

      <Dialog
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
        title="Attach from client files"
        width={780}
        footer={<><Button variant="secondary" size="sm" onPress={() => setFilesOpen(false)}>Cancel</Button><Button variant="primary" size="sm" onPress={saveFiles}>Attach files</Button></>}
      >
        <p className="mb-4 text-[13px] leading-5 text-ink-secondary">Documents already saved to a client record. Attaching does not move or change the file. Selected files will be attached to every email in this campaign.</p>
        <div className="grid min-h-[340px] grid-cols-1 overflow-hidden rounded-lg border border-line-hairline sm:grid-cols-[210px_minmax(0,1fr)]">
          <nav className="border-b border-line-hairline bg-surface-subtle p-2 sm:border-b-0 sm:border-r" aria-label="Client files portfolio">
            {!clientId && <button type="button" aria-current={filesClientId === '__general__' ? 'page' : undefined} onClick={() => { setFilesClientId('__general__'); setFilesSearch(''); }} className={`appearance-none border-0 mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] ${filesClientId === '__general__' ? 'bg-surface text-ink-primary shadow-card' : 'bg-transparent text-ink-secondary hover:bg-surface'}`}><span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${filesClientId === '__general__' ? 'btn-dark text-white' : 'bg-neutral-bg text-neutral-ink'}`}><Icon.Document size={13} /></span><span>General files</span></button>}
            {clients.map((client) => <button key={client.id} type="button" aria-current={filesClientId === client.id ? 'page' : undefined} onClick={() => { setFilesClientId(client.id); setFilesSearch(''); }} className={`appearance-none border-0 mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] ${filesClientId === client.id ? 'bg-surface text-ink-primary shadow-card' : 'bg-transparent text-ink-secondary hover:bg-surface'}`}><span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${filesClientId === client.id ? 'btn-dark' : 'bg-neutral-bg text-neutral-ink'}`}>{client.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span><span className="truncate">{client.name}</span></button>)}
            {clients.length === 0 && <p className="p-2 text-xs text-ink-tertiary">No clients available.</p>}
          </nav>
          <section className="min-w-0 p-3" aria-label={fileClient ? `${fileClient.name} files` : filesClientId === '__general__' ? 'General files' : 'Client files'}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="text-[13px] font-semibold text-ink-primary">{fileClient?.name ?? (filesClientId === '__general__' ? 'General files' : 'Available files')}</div><div className="text-[11px] text-ink-tertiary">{pendingFileIds.length} selected</div></div>
            <Input value={filesSearch} onChange={setFilesSearch} placeholder="Search client files…" leadingIcon={<Icon.SearchLg size={14} />} />
            <div className="mt-3 max-h-[300px] overflow-y-auto rounded-lg border border-line-hairline">
              {clientFilesQuery.isFetching && filesClientId !== clientId ? <div className="p-6 text-center text-xs text-ink-tertiary">Loading client files…</div> : filteredClientFiles.length ? filteredClientFiles.map((document) => {
                const detail = [document.folder, document.size ?? (document.byteSize != null ? `${Math.ceil(document.byteSize / 1024)} KB` : null), attachmentDate(document)].filter(Boolean).join(' · ');
                const fileType = attachmentTypeLabel(document);
                const isAttached = pendingFileIds.includes(document.id);
                return <div key={document.id} className="flex items-start gap-2 border-t border-line-hairline px-3 py-2.5 first:border-t-0"><Checkbox isSelected={isAttached} onChange={() => setPendingFileIds((current) => current.includes(document.id) ? current.filter((id) => id !== document.id) : [...current, document.id])}><span className="block text-[12.5px] font-medium">{document.fileName}</span>{detail && <span className="block text-[10px] text-ink-tertiary">{detail}</span>}</Checkbox>{isAttached && <span className="ml-auto shrink-0 rounded-full bg-neutral-bg px-2 py-0.5 text-[10px] text-ink-secondary">Attached</span>}<span className="shrink-0 rounded bg-neutral-bg px-1.5 py-0.5 text-[9px] font-semibold text-neutral-ink">{fileType}</span></div>;
              }) : <div className="p-6 text-center text-xs text-ink-tertiary">{filesSearch ? 'No files match your search.' : 'No saved files for this client.'}</div>}
            </div>
          </section>
        </div>
      </Dialog>
    </div>
  );
}

const BANNER_CLASS: Record<'warning' | 'error' | 'info', { box: string; text: string; icon: typeof Icon.AlertTriangle }> = {
  warning: {
    box: 'border-warning-border bg-warning-bg',
    text: 'text-warning-heading',
    icon: Icon.AlertTriangle,
  },
  error: {
    box: 'border-danger-border bg-danger-bg',
    text: 'text-danger',
    icon: Icon.AlertCircle,
  },
  info: {
    box: 'border-accent-border bg-accent-tint',
    text: 'text-accent-ink',
    icon: Icon.Info,
  },
};

/** The active draft's block-reason banner, plus the two non-blocking notes
 *  (auditor warning, silent-regenerate-failure) it replaces when absent. */
function DraftBanner({
  banner,
  draft,
  onApprove,
  onReject,
  deciding,
}: {
  banner: ReturnType<typeof draftBanner>;
  draft: GeneratedDraft | undefined;
  onApprove?: () => void;
  onReject?: () => void;
  deciding?: boolean;
}) {
  if (!banner) {
    // A non-blocking auditor warning is still worth surfacing.
    if (draft?.auditStatus === 'warning' && draft.contextNote) {
      return (
        <Banner type="warning" message="Review the flagged claims" description={draft.contextNote} />
      );
    }
    // A regenerate that failed while this draft already existed: the draft
    // below is the one that was already here, unchanged. Without this the
    // attempt fails silently and the user cannot tell whether they are
    // looking at new text or old.
    if (draft?.failureReason) {
      return (
        <Banner
          type="warning"
          message="The last attempt to regenerate this draft failed — your existing draft was kept"
          description={
            <>
              <div>{draft.failureReason}</div>
              <div className="mt-1.5 opacity-75">
                Nothing below was changed or lost. Fix the cause and regenerate, or send this draft
                as it stands.
              </div>
            </>
          }
        />
      );
    }
    return null;
  }
  return (
    <Banner
      type={banner.type}
      message={banner.message}
      description={
        <>
          <div>{banner.description}</div>
          {/* The internal auditor note: shown to the lobbyist ONLY, never
              appended to the subject/body a recipient sees. */}
          {draft?.contextNote ? <div className="mt-1.5">{draft.contextNote}</div> : null}
          {draft?.reviewRequestId ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {onApprove && (
                <Button variant="primary" size="sm" isDisabled={deciding} onPress={onApprove}>
                  <Icon.Check size={13} />
                  {deciding ? 'Deciding…' : 'Approve & release'}
                </Button>
              )}
              {onReject && (
                <Button variant="secondary" size="sm" isDisabled={deciding} onPress={onReject}>
                  <Icon.XClose size={13} />
                  Reject
                </Button>
              )}
              <a href={`/reviews?id=${draft.reviewRequestId}`} className="ml-1 underline">
                Open in Reviews
              </a>
            </div>
          ) : null}
          {isVersioned(draft) && draft?.version != null ? (
            <div className="mt-1.5 opacity-75">
              Version {draft.version}. Editing creates a new version and does not release this one.
            </div>
          ) : null}
        </>
      }
    />
  );
}

function Banner({
  type,
  message,
  description,
}: {
  type: 'warning' | 'error' | 'info';
  message: string;
  description: ReactNode;
}) {
  const c = BANNER_CLASS[type];
  return (
    <div className={`mb-3 flex gap-2.5 rounded-md border p-3 ${c.box}`}>
      <span className={`mt-0.5 flex-none ${c.text}`}>
        <c.icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-semibold ${c.text}`}>{message}</div>
        <div className="mt-0.5 text-[12.5px] leading-[1.5] text-ink-secondary">{description}</div>
      </div>
    </div>
  );
}

function editorContextLine(entity: RailEntity, slot: RailSlot): string {
  if (entity.kind === 'group') {
    const count = entity.target.recipients.length;
    return `${count} ${count === 1 ? 'contact' : 'contacts'} · one shared email`;
  }
  if (entity.kind === 'list') {
    return [slot.sub, entity.name].filter(Boolean).join(' · ');
  }
  return slot.sub;
}

function RailCard({
  entity,
  generated,
  activeKey,
  collapsed,
  onToggleCollapse,
  onSelect,
  onRegenerateOne,
  generatingKey,
  batchGenerating,
}: {
  entity: RailEntity;
  generated: WizardV2State['generatedEmails'];
  activeKey: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (key: string) => void;
  onRegenerateOne: (genKey: string) => void;
  generatingKey: string | null;
  batchGenerating: boolean;
}) {
  // Individuals and groups are a single selectable row (no expander). The
  // type is conveyed by the section header, so rows no longer carry a tag.
  if (entity.kind !== 'list') {
    const slot = entity.members[0];
    if (!slot) return null;
    return (
      <RailRow
        slot={slot}
        ready={isReady(generated[slot.genKey])}
        errored={generated[slot.genKey]?.status === 'error'}
        active={activeKey === slot.genKey}
        onSelect={onSelect}
        onRegenerateOne={onRegenerateOne}
        generating={generatingKey === slot.genKey || batchGenerating}
      />
    );
  }

  // List card: name header (with member count + ready count) that expands to
  // members. The "List" type is conveyed by the section header above.
  const readyCount = entity.members.filter((m) => isReady(generated[m.genKey])).length;
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left hover:bg-surface-subtle"
      >
        <span className="flex-none text-ink-tertiary">
          {collapsed ? <Icon.ChevronRight size={12} /> : <Icon.ChevronDown size={12} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-primary">
          {entity.name}
        </span>
        <span className="flex-none font-mono text-[11px] text-ink-tertiary">
          {readyCount}/{entity.members.length}
        </span>
      </button>
      {!collapsed && (
        <div className="ml-3 border-l border-line-divider pl-1">
          {entity.members.map((slot) => (
            <RailRow
              key={slot.genKey}
              slot={slot}
              ready={isReady(generated[slot.genKey])}
              errored={generated[slot.genKey]?.status === 'error'}
              active={activeKey === slot.genKey}
              onSelect={onSelect}
              onRegenerateOne={onRegenerateOne}
              generating={generatingKey === slot.genKey || batchGenerating}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RailRow({
  slot,
  ready,
  errored,
  active,
  onSelect,
  onRegenerateOne,
  generating,
}: {
  slot: RailSlot;
  ready: boolean;
  errored?: boolean;
  active: boolean;
  onSelect: (key: string) => void;
  onRegenerateOne: (genKey: string) => void;
  generating: boolean;
}) {
  return (
    <div
      onClick={() => onSelect(slot.genKey)}
      className={`group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 ${
        active ? 'border border-accent-border bg-accent-tint' : 'border border-transparent hover:bg-surface-subtle'
      }`}
    >
      <span className="flex h-4 w-4 flex-none items-center justify-center">
        {ready ? (
          <Icon.Check size={13} className="text-success" />
        ) : errored ? (
          <Icon.AlertCircle
            size={13}
            className="text-warning-heading"
            aria-label="Generation failed — edit or regenerate before sending"
          />
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] leading-5 font-semibold text-ink-primary">
          {slot.name}
        </div>
        {slot.sub && (
          <div className="truncate text-[11.5px] leading-4 text-ink-tertiary">{slot.sub}</div>
        )}
      </div>
      <button
        type="button"
        title="Regenerate just this draft"
        onClick={(e) => {
          e.stopPropagation();
          onRegenerateOne(slot.genKey);
        }}
        className="flex-none rounded-[5px] p-1 text-ink-tertiary opacity-0 hover:bg-surface hover:text-ink-primary group-hover:opacity-100"
      >
        <Icon.Zap size={13} className={generating ? 'animate-pulse' : ''} />
      </button>
    </div>
  );
}
