/**
 * ActionCard — renders ONE Step 3.2 action recommendation (plan §10 card spec).
 *
 * Shows every §10 field: issue title, what-changed, why-it-matters, recommended action,
 * action-type badge, target audience (each member with its §17 contact-use badge),
 * per-dimension confidence bands, uncertainty (prominent when set), deadline (or
 * "No known deadline") + its source, priority, status, and evidence chips that deep-link
 * to the proof pack. Also hosts the owner-assignment, status-advance, and (reason-gated)
 * dismissal controls. Every nested read is Array.isArray / null guarded so a thin or
 * malformed card never crashes the board.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Card,
  Dropdown,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ClockCircleOutlined,
  DownOutlined,
  FileTextOutlined,
  LinkOutlined,
  RightOutlined,
  TeamOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ActionCardDto, ActionStatus, AudienceMember, ConfidenceBand, EvidenceRef } from './types.js';
import {
  ACTION_TYPE_COLORS,
  ACTION_TYPE_LABELS,
  ALLOWED_TRANSITIONS,
  ARTIFACT_TYPE_LABELS,
  CONFIDENCE_BAND_COLORS,
  DEADLINE_SOURCE_LABELS,
  STATUS_LABELS,
  STATUS_TAG_COLORS,
} from './types.js';
import {
  useUpdateActionOwner,
  useUpdateActionStatus,
  type TeamMemberOption,
} from './actions-api.js';
import { CoveragePanel } from './CoveragePanel.js';
import { ArtifactsPanel } from './ArtifactsPanel.js';

const { Text, Paragraph, Title } = Typography;

function formatDeadline(iso: string | null): string {
  if (!iso) return 'No known deadline';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No known deadline';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function memberName(member: TeamMemberOption): string {
  const full = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return full || member.email || member.userId;
}

/** A single confidence dimension chip (skipped when the band is absent). */
function ConfidenceChip({ label, band }: { label: string; band?: ConfidenceBand }) {
  if (!band) return null;
  return (
    <Tag color={CONFIDENCE_BAND_COLORS[band]}>
      {label}: {band}
    </Tag>
  );
}

export function ActionCard({
  card,
  teamMembers,
  compact = false,
}: {
  card: ActionCardDto;
  teamMembers: TeamMemberOption[];
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const updateStatus = useUpdateActionStatus();
  const updateOwner = useUpdateActionOwner();

  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  // Coverage is fetched LAZILY: only once the user expands this card's sub-section, so the
  // board never fires one coverage request per card. `coverageEnabled` latches true on first
  // expand and stays true so a collapse/re-expand reuses the cached query.
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [coverageEnabled, setCoverageEnabled] = useState(false);
  // Artifacts (Step 3.3) are fetched LAZILY too — same latch pattern as Coverage, so the
  // board never fires one artifacts request per card.
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactsEnabled, setArtifactsEnabled] = useState(false);

  const audience = Array.isArray(card.targetAudience) ? card.targetAudience : [];
  const evidence = Array.isArray(card.evidence) ? card.evidence : [];
  const confidence = card.confidence ?? {};
  const members = Array.isArray(teamMembers) ? teamMembers : [];

  // §19 advance options = legal transitions minus `dismissed` (dismissal is its own
  // reason-gated control). `archived` and other terminal states yield an empty menu.
  const advanceTargets = useMemo<ActionStatus[]>(
    () => (ALLOWED_TRANSITIONS[card.status] ?? []).filter((s) => s !== 'dismissed'),
    [card.status],
  );

  const canDismiss = (ALLOWED_TRANSITIONS[card.status] ?? []).includes('dismissed');

  function handleAdvance(target: ActionStatus) {
    updateStatus.mutate(
      { id: card.id, status: target },
      {
        onSuccess: () => message.success(`Moved to ${STATUS_LABELS[target]}`),
        onError: (err) => message.error(err.message || 'Could not update status'),
      },
    );
  }

  function submitDismiss() {
    const reason = dismissReason.trim();
    if (!reason) return; // guarded; submit button is also disabled
    updateStatus.mutate(
      { id: card.id, status: 'dismissed', dismissalReason: reason },
      {
        onSuccess: () => {
          message.success('Action dismissed');
          setDismissOpen(false);
          setDismissReason('');
        },
        onError: (err) => message.error(err.message || 'Could not dismiss action'),
      },
    );
  }

  function toggleCoverage() {
    setCoverageOpen((open) => {
      const next = !open;
      if (next) setCoverageEnabled(true); // latch the lazy fetch on first expand
      return next;
    });
  }

  function toggleArtifacts() {
    setArtifactsOpen((open) => {
      const next = !open;
      if (next) setArtifactsEnabled(true); // latch the lazy fetch on first expand
      return next;
    });
  }

  function handleOwnerChange(value: string | null) {
    updateOwner.mutate(
      { id: card.id, ownerUserId: value },
      {
        onSuccess: () => message.success(value ? 'Owner assigned' : 'Owner cleared'),
        onError: (err) => message.error(err.message || 'Could not update owner'),
      },
    );
  }

  function evidenceTarget(ref: EvidenceRef): string {
    // Proof pack for the PE is the honest landing spot; carry delta/source ids as query
    // params so the destination can scroll to the relevant proof when it supports it.
    const params = new URLSearchParams();
    if (ref.deltaId) params.set('delta', ref.deltaId);
    if (ref.sourceDocumentId) params.set('source', ref.sourceDocumentId);
    if (ref.page != null) params.set('page', String(ref.page));
    const qs = params.toString();
    return `/program-elements/${encodeURIComponent(card.peCode ?? '')}${qs ? `?${qs}` : ''}`;
  }

  function evidenceLabel(ref: EvidenceRef): string {
    switch (ref.kind) {
      case 'delta':
        return 'Budget delta';
      case 'source':
        return ref.page != null ? `Source p.${ref.page}` : 'Source doc';
      case 'provision':
        return ref.note || 'Provision';
      case 'opportunity':
        return 'Opportunity';
      default:
        return 'Evidence';
    }
  }

  // An evidence ref is deep-linkable when it carries a delta or a source-document id AND we
  // have a PE to land on (the proof pack lives under /program-elements/:peCode).
  const isLinkable = (ref: EvidenceRef) =>
    Boolean(card.peCode && (ref.deltaId || ref.sourceDocumentId));

  return (
    <Card
      className={compact ? 'action-card compact' : 'action-card'}
      size="small"
      title={
        <div className="action-card-badges">
          <Tag color={ACTION_TYPE_COLORS[card.actionType] ?? 'default'}>
            {ACTION_TYPE_LABELS[card.actionType] ?? card.actionType}
          </Tag>
          <Tag color={STATUS_TAG_COLORS[card.status] ?? 'default'}>
            {STATUS_LABELS[card.status] ?? card.status}
          </Tag>
          <Tooltip title="Priority (0–100)">
            <Tag>Priority {Number.isFinite(card.priority) ? card.priority : 0}</Tag>
          </Tooltip>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <Title level={5} style={{ margin: 0 }}>
            {card.issueTitle || 'Untitled action'}
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {card.clientName || card.clientId}
            {card.peCode ? ` · PE ${card.peCode}` : ''}
          </Text>
        </div>

        {card.uncertainty ? (
          <div className="action-card-uncertainty" role="alert">
            <Space size={6} align="start">
              <WarningOutlined style={{ color: '#faad14', marginTop: 2 }} />
              <Text>{card.uncertainty}</Text>
            </Space>
          </div>
        ) : null}

        <div>
          <div className="action-card-section-label">What changed</div>
          <Paragraph style={{ margin: 0 }}>{card.whatChanged || '—'}</Paragraph>
        </div>

        <div className="action-card-detail">
          <div className="action-card-section-label">Why it matters</div>
          <Paragraph style={{ margin: 0 }}>{card.whyItMatters || '—'}</Paragraph>
        </div>

        <div className="action-card-detail">
          <div className="action-card-section-label">Recommended action</div>
          <Paragraph style={{ margin: 0 }} strong>
            {card.recommendedAction || '—'}
          </Paragraph>
          {card.suggestedArtifactType ? (
            <Tag style={{ marginTop: 4 }}>
              Deliverable: {ARTIFACT_TYPE_LABELS[card.suggestedArtifactType] ?? card.suggestedArtifactType}
            </Tag>
          ) : null}
        </div>

        <div className="action-card-detail">
          <div className="action-card-section-label">Target audience</div>
          {audience.length ? (
            <div className="action-card-badges">
              {audience.map((m: AudienceMember, idx) => (
                <Tag key={m.id || `${m.kind}-${idx}`} icon={<UserOutlined />}>
                  {m.label || m.id || 'Unknown'}
                  {m.contactUse ? (
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                      ({m.contactUse})
                    </Text>
                  ) : null}
                  {/* Distinguish context-only person contacts (outreachEligible !== true) so a
                      user doesn't mistake a background contact for an outreach target. Only
                      person_role members carry the §17 eligibility flag; committees/offices
                      are left unannotated. */}
                  {m.kind === 'person_role' && m.outreachEligible !== true ? (
                    <Tooltip title="Context only — not an outreach/lobbying target">
                      <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                        context
                      </Text>
                    </Tooltip>
                  ) : null}
                </Tag>
              ))}
            </div>
          ) : (
            <Text type="secondary">No audience identified yet</Text>
          )}
        </div>

        <div>
          <div className="action-card-section-label">Deadline</div>
          {card.deadline ? (
            <Space size={6}>
              <ClockCircleOutlined />
              <Text>{formatDeadline(card.deadline)}</Text>
              {card.deadlineSource ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ({DEADLINE_SOURCE_LABELS[card.deadlineSource] ?? card.deadlineSource})
                </Text>
              ) : null}
            </Space>
          ) : (
            <Text className="action-card-deadline--none">No known deadline</Text>
          )}
        </div>

        <div className="action-card-detail">
          <div className="action-card-section-label">Confidence</div>
          <div className="action-card-badges">
            <ConfidenceChip label="Delta" band={confidence.delta} />
            <ConfidenceChip label="Program match" band={confidence.programMatch} />
            <ConfidenceChip label="People match" band={confidence.peopleMatch} />
            <ConfidenceChip label="Client relevance" band={confidence.clientRelevance} />
            {!confidence.delta &&
            !confidence.programMatch &&
            !confidence.peopleMatch &&
            !confidence.clientRelevance ? (
              <Text type="secondary">Not assessed</Text>
            ) : null}
          </div>
        </div>

        {evidence.length ? (
          <div className="action-card-detail">
            <div className="action-card-section-label">Evidence</div>
            <div className="action-card-evidence">
              {evidence.map((ref, idx) =>
                isLinkable(ref) ? (
                  <Tag
                    key={`${ref.kind}-${idx}`}
                    color="blue"
                    icon={<LinkOutlined />}
                    role="button"
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(evidenceTarget(ref))}
                  >
                    {evidenceLabel(ref)}
                  </Tag>
                ) : (
                  <Tag key={`${ref.kind}-${idx}`} icon={<LinkOutlined />}>
                    {evidenceLabel(ref)}
                  </Tag>
                ),
              )}
            </div>
          </div>
        ) : null}

        <div className="action-card-coverage action-card-detail">
          <button
            type="button"
            className="action-card-coverage-toggle"
            aria-expanded={coverageOpen}
            onClick={toggleCoverage}
          >
            {coverageOpen ? <DownOutlined /> : <RightOutlined />}
            <TeamOutlined />
            <span>Relationship coverage</span>
          </button>
          {coverageOpen ? (
            <CoveragePanel actionId={card.id} teamMembers={members} enabled={coverageEnabled} />
          ) : null}
        </div>

        <div className="action-card-artifacts action-card-detail">
          <button
            type="button"
            className="action-card-coverage-toggle"
            aria-expanded={artifactsOpen}
            onClick={toggleArtifacts}
          >
            {artifactsOpen ? <DownOutlined /> : <RightOutlined />}
            <FileTextOutlined />
            <span>Artifacts</span>
          </button>
          {artifactsOpen ? (
            <ArtifactsPanel
              actionId={card.id}
              suggestedArtifactType={card.suggestedArtifactType}
              enabled={artifactsEnabled}
            />
          ) : null}
        </div>

        {!compact ? (
          <div className="action-card-footer">
            <Select<string | null>
              size="small"
              allowClear
              showSearch
              style={{ minWidth: 180 }}
              placeholder="Assign owner"
              value={card.ownerUserId ?? undefined}
              onChange={(v) => handleOwnerChange(v ?? null)}
              loading={updateOwner.isPending}
              optionFilterProp="label"
              options={members.map((m) => ({ value: m.userId, label: memberName(m) }))}
              notFoundContent={members.length ? undefined : 'No team members'}
            />

            {advanceTargets.length ? (
              <Dropdown
                menu={{
                  items: advanceTargets.map((s) => ({ key: s, label: STATUS_LABELS[s] })),
                  onClick: ({ key }) => handleAdvance(key as ActionStatus),
                }}
                disabled={updateStatus.isPending}
              >
                <Button size="small">
                  Advance <DownOutlined />
                </Button>
              </Dropdown>
            ) : null}

            {canDismiss ? (
              <Button size="small" danger onClick={() => setDismissOpen(true)}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}

        {card.status === 'dismissed' && card.dismissalReason ? (
          <Text type="secondary" italic>
            Dismissed: {card.dismissalReason}
          </Text>
        ) : null}
      </div>

      <Modal
        title="Dismiss action"
        open={dismissOpen}
        onCancel={() => setDismissOpen(false)}
        okText="Dismiss"
        okButtonProps={{
          danger: true,
          // AntD treats `loading` and `disabled` independently, so a spinner alone does not
          // block a second click; disable while the PATCH is in flight to stop a double
          // dismiss (which 400s on dismissed->dismissed).
          disabled: !dismissReason.trim() || updateStatus.isPending,
          loading: updateStatus.isPending,
        }}
        onOk={submitDismiss}
      >
        <Paragraph type="secondary">
          A dismissal reason is required — we never dismiss an action silently.
        </Paragraph>
        <Input.TextArea
          aria-label="Dismissal reason"
          placeholder="Why is this action being dismissed?"
          rows={3}
          value={dismissReason}
          onChange={(e) => setDismissReason(e.target.value)}
        />
      </Modal>
    </Card>
  );
}
