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

import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Input, Select, Space, Typography, Upload } from 'antd';
import {
  CheckOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  PaperClipOutlined,
  RightOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { GeneratedDraft, WizardV2State } from './types.js';
import {
  DRAFT_BLOCK_COPY,
  draftBlockReason,
  isDraftSendable,
  isVersioned,
} from './versioned-drafts.js';
import { listAidFromKey, type GenSlot, type RailEntity, type RailSlot } from './generation.js';
import { RichTextEditor } from './RichTextEditor.js';
import './step-generate.css';

interface AttachmentDoc {
  id: string;
  fileName: string;
  contentType: string;
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
  /** Context (or template/tone) changed since these drafts were generated. */
  contextStale?: boolean;
  onEdit: (genKey: string, patch: { subject?: string; body?: string }) => void;
  onApplyToList: (listAid: string, sourceKey: string) => void;
  regenerating: boolean;
  generatingKey: string | null;
  // Attachments (campaign-level; preserved from production).
  clientId: string | null;
  docs: AttachmentDoc[];
  attachmentIds: string[];
  onToggleAttachment: (id: string) => void;
  onUploadAttachment: (file: File) => void;
}

const KIND_BADGE: Record<RailEntity['kind'], { label: string; cls: string; icon: JSX.Element }> = {
  individual: { label: 'Individual', cls: 'individual', icon: <UserOutlined /> },
  list: { label: 'List', cls: 'list', icon: <UnorderedListOutlined /> },
  group: { label: 'Group', cls: 'group', icon: <TeamOutlined /> },
};

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
    case 'dirty':
      return { type: 'info', message: 'Unsaved changes', description: DRAFT_BLOCK_COPY.dirty };
    case 'generation_failed':
      return {
        type: 'warning',
        message: "This draft couldn't be generated",
        description:
          'It will not be sent as-is. Edit the text below, or click "Regenerate this" to try again.',
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
  contextStale,
  onEdit,
  onApplyToList,
  regenerating,
  generatingKey,
  clientId,
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
      <div>
        <h2>Generate &amp; review</h2>
        <div className="ov2-pane-sub">
          Add recipients first, then come back to draft their emails.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>Generate &amp; review</h2>
      <div className="ov2-pane-sub">
        Meri drafts a unique email for each individual and list member, and one shared email per
        group. Edit any draft inline, regenerate, or save everything as a draft to finish later.
      </div>

      {contextStale && (
        <div className="ov2-gen-stale" role="status">
          <span className="ov2-gen-stale-ico">
            <ThunderboltOutlined />
          </span>
          <span className="ov2-gen-stale-msg">
            Your context changed since these drafts were generated. Regenerate to apply it
            {' '}
            <em>(this replaces every draft, including any manual edits)</em>.
          </span>
          <button
            type="button"
            className="ov2-gen-stale-btn"
            onClick={onRegenerateAll}
            disabled={batchGenerating}
          >
            {batchGenerating ? 'Regenerating…' : 'Regenerate all'}
          </button>
        </div>
      )}

      <div className="ov2-gen-grid">
        {/* ---- Left rail ---- */}
        <div className="ov2-gen-rail">
          <div className="ov2-gen-pill">
            <ThunderboltOutlined /> {batchGenerating ? 'Generating…' : `${ready} / ${total} ready`}
          </div>
          <div className="ov2-gen-rail-scroll">
            {(['individual', 'list', 'group'] as const).map((kind) => {
              const ents = entities.filter((e) => e.kind === kind);
              if (ents.length === 0) return null;
              return (
                <div key={kind} className={`ov2-gen-section ${kind}`}>
                  <div className="ov2-gen-section-head">
                    {KIND_BADGE[kind].icon}
                    <span className="lbl">{KIND_BADGE[kind].label}</span>
                    <span className="cnt">{ents.length}</span>
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
        <div className="ov2-gen-editor">
          <div className="ov2-gen-editor-head">
            {active && (
              <div className="ov2-gen-editor-title">
                <span className={`ov2-gen-badge ${KIND_BADGE[active.entity.kind].cls}`}>
                  {KIND_BADGE[active.entity.kind].icon} {KIND_BADGE[active.entity.kind].label}
                </span>
                <span className="name">{active.slot.name}</span>
                <span className="ctx">{editorContextLine(active.entity, active.slot)}</span>
              </div>
            )}
            <Select
              value={tone}
              onChange={onTone}
              className="ov2-gen-tone"
              options={[
                { value: 'professional', label: 'Professional' },
                { value: 'friendly', label: 'Friendly' },
                { value: 'formal', label: 'Formal' },
                { value: 'concise', label: 'Concise' },
              ]}
            />
            <Button
              icon={<ThunderboltOutlined />}
              loading={(!!activeKey && generatingKey === activeKey) || batchGenerating}
              onClick={() => activeKey && onRegenerateOne(activeKey)}
              disabled={!activeKey}
            >
              Regenerate this
            </Button>
            <Button
              icon={<ThunderboltOutlined />}
              loading={batchGenerating}
              onClick={onRegenerateAll}
            >
              Regenerate all
            </Button>
          </div>

          {bannerFor && bannerFor === activeKey && active?.slot.appliesTo === 'member' && (
            <div className="ov2-gen-propagate">
              <span className="msg">
                <b>You edited this draft.</b> Apply this change to all{' '}
                {active.entity.members.length}{' '}
                {active.entity.members.length === 1 ? 'member' : 'members'} in {active.entity.name}?
              </span>
              <span className="spacer" />
              <Button
                type="primary"
                className="ov2-gen-apply-all"
                onClick={() => {
                  const aid = listAidFromKey(activeKey);
                  if (aid) onApplyToList(aid, activeKey);
                  setBannerFor(null);
                }}
              >
                Apply to all in list
              </Button>
              <Button onClick={() => setBannerFor(null)}>Save individual only</Button>
            </div>
          )}

          <div className="ov2-gen-editor-body">
            {(() => {
              const banner = draftBanner(activeDraft);
              if (!banner) {
                // A non-blocking auditor warning is still worth surfacing.
                if (activeDraft?.auditStatus === 'warning' && activeDraft.contextNote) {
                  return (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="Review the flagged claims"
                      description={activeDraft.contextNote}
                    />
                  );
                }
                return null;
              }
              return (
                <Alert
                  type={banner.type}
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={banner.message}
                  description={
                    <>
                      <div>{banner.description}</div>
                      {/* The internal auditor note: shown to the lobbyist ONLY,
                          never appended to the subject/body a recipient sees. */}
                      {activeDraft?.contextNote ? (
                        <div style={{ marginTop: 6 }}>{activeDraft.contextNote}</div>
                      ) : null}
                      {activeDraft?.reviewRequestId ? (
                        <div style={{ marginTop: 6 }}>
                          <a href={`/reviews?id=${activeDraft.reviewRequestId}`}>
                            Open this draft in Reviews
                          </a>
                        </div>
                      ) : null}
                      {isVersioned(activeDraft) && activeDraft?.version != null ? (
                        <div style={{ marginTop: 6, opacity: 0.75 }}>
                          Version {activeDraft.version}. Editing creates a new version and does not
                          release this one.
                        </div>
                      ) : null}
                    </>
                  }
                />
              );
            })()}
            {activeDraft ? (
              <>
                <div className="ov2-gen-field-label">Subject</div>
                <Input
                  value={activeDraft.subject}
                  onChange={(e) => editActive({ subject: e.target.value })}
                  placeholder="Email subject"
                />
                <div className="ov2-gen-field-label" style={{ marginTop: 14 }}>
                  Body
                </div>
                <RichTextEditor
                  value={activeDraft.body}
                  onChange={(html) => editActive({ body: html })}
                  placeholder="Write the email…"
                />
                <div className="ov2-gen-improve" style={{ marginTop: 14 }}>
                  <div className="ov2-gen-field-label">Improve with Meri</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input
                      value={improveText}
                      onChange={(e) => setImproveText(e.target.value)}
                      onPressEnter={submitImprove}
                      placeholder="e.g. make it warmer, tighten the ask, add a line about the markup"
                      disabled={!!activeKey && generatingKey === activeKey}
                    />
                    <Button
                      type="primary"
                      icon={<ThunderboltOutlined />}
                      loading={!!activeKey && generatingKey === activeKey}
                      disabled={!improveText.trim()}
                      onClick={submitImprove}
                    >
                      Improve
                    </Button>
                  </div>
                  {!!activeDraft.history?.length && (
                    <Button
                      type="link"
                      size="small"
                      style={{ paddingLeft: 0, marginTop: 4 }}
                      onClick={() => activeKey && onRevert(activeKey)}
                    >
                      Revert last change
                    </Button>
                  )}
                </div>
                <Typography.Text type="secondary" className="ov2-gen-autosave">
                  Edits save automatically. Use “Save as draft” below to keep everything and finish
                  later.
                </Typography.Text>
              </>
            ) : (
              <Typography.Text type="secondary">
                {(!!activeKey && generatingKey === activeKey) || batchGenerating
                  ? 'Generating…'
                  : 'No draft yet. Click “Regenerate this”.'}
              </Typography.Text>
            )}
          </div>
        </div>
      </div>

      {/* ---- Campaign-level attachments (production feature, preserved) ---- */}
      <div className="ov2-gen-attachments">
        <Typography.Title level={5} style={{ marginBottom: 4 }}>
          Attachments
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          Files added here are attached to every email on send (max 3MB each).
        </Typography.Paragraph>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          {docs.map((d) => (
            <Checkbox
              key={d.id}
              checked={attachmentIds.includes(d.id)}
              onChange={() => onToggleAttachment(d.id)}
            >
              {d.fileName}
            </Checkbox>
          ))}
          {docs.length === 0 && (
            <Typography.Text type="secondary">
              {clientId
                ? 'No stored documents for this client yet. Upload a file to attach it.'
                : 'No attachments yet. Upload a file to attach it to every email.'}
            </Typography.Text>
          )}
          <Upload
            multiple
            showUploadList={false}
            beforeUpload={(file) => {
              onUploadAttachment(file as File);
              return false; // handle the upload ourselves; skip AntD's default
            }}
          >
            <Button size="small" icon={<PaperClipOutlined />}>
              Upload a file
            </Button>
          </Upload>
        </Space>
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
      <div className="ov2-gen-card">
        <RailRow
          slot={slot}
          ready={isReady(generated[slot.genKey])}
          errored={generated[slot.genKey]?.status === 'error'}
          active={activeKey === slot.genKey}
          onSelect={onSelect}
          onRegenerateOne={onRegenerateOne}
          generating={generatingKey === slot.genKey || batchGenerating}
        />
      </div>
    );
  }

  // List card: name header (with member count + ready count) that expands to
  // members. The "List" type is conveyed by the section header above.
  const readyCount = entity.members.filter((m) => isReady(generated[m.genKey])).length;
  return (
    <div className="ov2-gen-card list">
      <button type="button" className="ov2-gen-listhead" onClick={onToggleCollapse}>
        <span className="caret">{collapsed ? <RightOutlined /> : <DownOutlined />}</span>
        <span className="name">{entity.name}</span>
        <span className="count">
          · {readyCount}/{entity.members.length} drafts
        </span>
      </button>
      {!collapsed &&
        entity.members.map((slot) => (
          <RailRow
            key={slot.genKey}
            slot={slot}
            indented
            ready={isReady(generated[slot.genKey])}
            errored={generated[slot.genKey]?.status === 'error'}
            active={activeKey === slot.genKey}
            onSelect={onSelect}
            onRegenerateOne={onRegenerateOne}
            generating={generatingKey === slot.genKey || batchGenerating}
          />
        ))}
    </div>
  );
}

function RailRow({
  slot,
  ready,
  errored,
  active,
  indented,
  onSelect,
  onRegenerateOne,
  generating,
}: {
  slot: RailSlot;
  ready: boolean;
  errored?: boolean;
  active: boolean;
  indented?: boolean;
  onSelect: (key: string) => void;
  onRegenerateOne: (genKey: string) => void;
  generating: boolean;
}) {
  return (
    <div
      className={'ov2-gen-row' + (active ? ' active' : '') + (indented ? ' indented' : '')}
      onClick={() => onSelect(slot.genKey)}
    >
      <span className={'ov2-gen-check' + (ready ? ' ready' : '')}>
        {ready ? (
          <CheckOutlined />
        ) : errored ? (
          <ExclamationCircleOutlined
            style={{ color: 'var(--ov2-warn, #d97706)' }}
            title="Generation failed — edit or regenerate before sending"
          />
        ) : null}
      </span>
      <div className="ov2-gen-row-main">
        <div className="ov2-gen-row-name">{slot.name}</div>
        {slot.sub && <div className="ov2-gen-row-sub">{slot.sub}</div>}
      </div>
      <Button
        size="small"
        type="text"
        icon={<ThunderboltOutlined />}
        loading={generating}
        title="Regenerate just this draft"
        onClick={(e) => {
          e.stopPropagation();
          onRegenerateOne(slot.genKey);
        }}
      />
    </div>
  );
}
