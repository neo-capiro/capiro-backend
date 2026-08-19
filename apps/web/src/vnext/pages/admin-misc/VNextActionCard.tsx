/**
 * vNext re-skin of pages/actions/ActionCard.tsx — ONE Step 3.2 action
 * recommendation (plan §10 card spec). Identical hooks (actions-api.js reused
 * verbatim), §19 transition rules, reason-gated dismissal, evidence deep links
 * into the PE proof pack, §17 contact-use / context-only annotations, and the
 * lazy coverage/artifacts latches. Every nested read stays Array.isArray /
 * null guarded so a thin or malformed card never crashes the board.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ActionCardDto,
  ActionStatus,
  AudienceMember,
  ConfidenceBand,
  EvidenceRef,
} from '../../../pages/actions/types.js';
import {
  ACTION_TYPE_COLORS,
  ACTION_TYPE_LABELS,
  ALLOWED_TRANSITIONS,
  ARTIFACT_TYPE_LABELS,
  CONFIDENCE_BAND_COLORS,
  DEADLINE_SOURCE_LABELS,
  STATUS_LABELS,
  STATUS_TAG_COLORS,
} from '../../../pages/actions/types.js';
import {
  useUpdateActionOwner,
  useUpdateActionStatus,
  type TeamMemberOption,
} from '../../../pages/actions/actions-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroMenu, CapiroPopover, CapiroTooltip } from '../../components/menus/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { SvCallout, SvCard, SvTextArea, svBadgeTone } from '../settings/settings-ui.js';
import { VNextCoveragePanel } from './VNextCoveragePanel.js';
import { VNextArtifactsPanel } from './VNextArtifactsPanel.js';

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
    <CapiroBadge tone={svBadgeTone(CONFIDENCE_BAND_COLORS[band])}>
      {label}: {band}
    </CapiroBadge>
  );
}

export function VNextActionCard({
  card,
  teamMembers,
  compact = false,
}: {
  card: ActionCardDto;
  teamMembers: TeamMemberOption[];
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const toast = useCapiroToast();
  const updateStatus = useUpdateActionStatus();
  const updateOwner = useUpdateActionOwner();

  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  // Coverage is fetched LAZILY: only once the user expands this card's sub-section, so the
  // board never fires one coverage request per card. `coverageEnabled` latches true on first
  // expand and stays true so a collapse/re-expand reuses the cached query.
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [coverageEnabled, setCoverageEnabled] = useState(false);
  // Artifacts (Step 3.3) are fetched LAZILY too — same latch pattern as Coverage.
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
        onSuccess: () => toast.success(`Moved to ${STATUS_LABELS[target]}`),
        onError: (err) => toast.error(err.message || 'Could not update status'),
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
          toast.success('Action dismissed');
          setDismissOpen(false);
          setDismissReason('');
        },
        onError: (err) => toast.error(err.message || 'Could not dismiss action'),
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
        onSuccess: () => toast.success(value ? 'Owner assigned' : 'Owner cleared'),
        onError: (err) => toast.error(err.message || 'Could not update owner'),
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
    <SvCard
      className={compact ? 'amx-action-card--compact' : undefined}
      aria-label={card.issueTitle || 'Untitled action'}
      title={
        <span className="amx-card-badges">
          <CapiroBadge tone={svBadgeTone(ACTION_TYPE_COLORS[card.actionType] ?? 'default')}>
            {ACTION_TYPE_LABELS[card.actionType] ?? card.actionType}
          </CapiroBadge>
          <CapiroBadge tone={svBadgeTone(STATUS_TAG_COLORS[card.status] ?? 'default')}>
            {STATUS_LABELS[card.status] ?? card.status}
          </CapiroBadge>
          <CapiroTooltip content="Priority (0–100)">
            <CapiroBadge>Priority {Number.isFinite(card.priority) ? card.priority : 0}</CapiroBadge>
          </CapiroTooltip>
        </span>
      }
    >
      <div className="stv-stack stv-stack--tight">
        <div>
          <span className="stv-strong" style={{ fontSize: 15, display: 'block' }}>
            {card.issueTitle || 'Untitled action'}
          </span>
          <span className="stv-muted stv-small">
            {card.clientName || card.clientId}
            {card.peCode ? ` · PE ${card.peCode}` : ''}
          </span>
        </div>

        {card.uncertainty ? <SvCallout kind="warning" title={card.uncertainty} /> : null}

        <div>
          <div className="amx-section-label">What changed</div>
          <p style={{ margin: 0 }}>{card.whatChanged || '—'}</p>
        </div>

        <div className="amx-card-detail">
          <div className="amx-section-label">Why it matters</div>
          <p style={{ margin: 0 }}>{card.whyItMatters || '—'}</p>
        </div>

        <div className="amx-card-detail">
          <div className="amx-section-label">Recommended action</div>
          <p className="stv-strong" style={{ margin: 0 }}>
            {card.recommendedAction || '—'}
          </p>
          {card.suggestedArtifactType ? (
            <span style={{ display: 'inline-flex', marginTop: 4 }}>
              <CapiroBadge>
                Deliverable:{' '}
                {ARTIFACT_TYPE_LABELS[card.suggestedArtifactType] ?? card.suggestedArtifactType}
              </CapiroBadge>
            </span>
          ) : null}
        </div>

        <div className="amx-card-detail">
          <div className="amx-section-label">Target audience</div>
          {audience.length ? (
            <div className="amx-card-badges">
              {audience.map((m: AudienceMember, idx) => (
                <CapiroBadge key={m.id || `${m.kind}-${idx}`}>
                  {m.label || m.id || 'Unknown'}
                  {m.contactUse ? (
                    <span className="stv-muted" style={{ marginLeft: 4 }}>
                      ({m.contactUse})
                    </span>
                  ) : null}
                  {/* Distinguish context-only person contacts (outreachEligible !== true) so a
                      user doesn't mistake a background contact for an outreach target. Only
                      person_role members carry the §17 eligibility flag; committees/offices
                      are left unannotated. */}
                  {m.kind === 'person_role' && m.outreachEligible !== true ? (
                    <CapiroTooltip content="Context only — not an outreach/lobbying target">
                      <span className="stv-muted" style={{ marginLeft: 4 }}>
                        context
                      </span>
                    </CapiroTooltip>
                  ) : null}
                </CapiroBadge>
              ))}
            </div>
          ) : (
            <span className="stv-muted">No audience identified yet</span>
          )}
        </div>

        <div>
          <div className="amx-section-label">Deadline</div>
          {card.deadline ? (
            <span className="stv-row" style={{ gap: 6 }}>
              <span>{formatDeadline(card.deadline)}</span>
              {card.deadlineSource ? (
                <span className="stv-muted stv-small">
                  ({DEADLINE_SOURCE_LABELS[card.deadlineSource] ?? card.deadlineSource})
                </span>
              ) : null}
            </span>
          ) : (
            <span className="stv-muted">No known deadline</span>
          )}
        </div>

        <div className="amx-card-detail">
          <div className="amx-section-label">Confidence</div>
          <div className="amx-card-badges">
            <ConfidenceChip label="Delta" band={confidence.delta} />
            <ConfidenceChip label="Program match" band={confidence.programMatch} />
            <ConfidenceChip label="People match" band={confidence.peopleMatch} />
            <ConfidenceChip label="Client relevance" band={confidence.clientRelevance} />
            {!confidence.delta &&
            !confidence.programMatch &&
            !confidence.peopleMatch &&
            !confidence.clientRelevance ? (
              <span className="stv-muted">Not assessed</span>
            ) : null}
          </div>
        </div>

        {evidence.length ? (
          <div className="amx-card-detail">
            <div className="amx-section-label">Evidence</div>
            <div className="amx-evidence">
              {evidence.map((ref, idx) =>
                isLinkable(ref) ? (
                  <button
                    key={`${ref.kind}-${idx}`}
                    type="button"
                    className="amx-chip-button"
                    onClick={() => navigate(evidenceTarget(ref))}
                  >
                    <CapiroBadge tone="info">{evidenceLabel(ref)}</CapiroBadge>
                  </button>
                ) : (
                  <CapiroBadge key={`${ref.kind}-${idx}`}>{evidenceLabel(ref)}</CapiroBadge>
                ),
              )}
            </div>
          </div>
        ) : null}

        <div className="amx-subsection amx-card-detail">
          <button
            type="button"
            className="amx-subsection-toggle"
            aria-expanded={coverageOpen}
            onClick={toggleCoverage}
          >
            <span aria-hidden="true">{coverageOpen ? '▾' : '▸'}</span>
            <span>Relationship coverage</span>
          </button>
          {coverageOpen ? (
            <VNextCoveragePanel actionId={card.id} teamMembers={members} enabled={coverageEnabled} />
          ) : null}
        </div>

        <div className="amx-subsection amx-card-detail">
          <button
            type="button"
            className="amx-subsection-toggle"
            aria-expanded={artifactsOpen}
            onClick={toggleArtifacts}
          >
            <span aria-hidden="true">{artifactsOpen ? '▾' : '▸'}</span>
            <span>Artifacts</span>
          </button>
          {artifactsOpen ? (
            <VNextArtifactsPanel
              actionId={card.id}
              suggestedArtifactType={card.suggestedArtifactType}
              enabled={artifactsEnabled}
            />
          ) : null}
        </div>

        {!compact ? (
          <div className="amx-card-footer">
            <span style={{ minWidth: 180 }}>
              <CapiroSelect
                label="Assign owner"
                aria-busy={updateOwner.isPending || undefined}
                value={card.ownerUserId ?? ''}
                onChange={(e) => handleOwnerChange(e.target.value || null)}
                options={[
                  {
                    value: '',
                    label: members.length ? 'Unassigned' : 'No team members',
                  },
                  ...members.map((m) => ({ value: m.userId, label: memberName(m) })),
                ]}
              />
            </span>

            {advanceTargets.length ? (
              <CapiroPopover
                label="Advance status"
                trigger={
                  <span className="capiro-button capiro-button--secondary capiro-button--compact">
                    Advance ▾
                  </span>
                }
              >
                <CapiroMenu
                  label="Advance to"
                  items={advanceTargets.map((s) => ({
                    id: s,
                    label: STATUS_LABELS[s],
                    disabled: updateStatus.isPending,
                    onSelect: () => handleAdvance(s),
                  }))}
                />
              </CapiroPopover>
            ) : null}

            {canDismiss ? (
              <CapiroButton
                size="compact"
                className="stv-btn-danger"
                onClick={() => setDismissOpen(true)}
              >
                Dismiss
              </CapiroButton>
            ) : null}
          </div>
        ) : null}

        {card.status === 'dismissed' && card.dismissalReason ? (
          <span className="stv-muted" style={{ fontStyle: 'italic' }}>
            Dismissed: {card.dismissalReason}
          </span>
        ) : null}
      </div>

      {dismissOpen ? (
        <CapiroModal open title="Dismiss action" onClose={() => setDismissOpen(false)}>
          <div className="stv-stack">
            <p className="stv-muted" style={{ margin: 0 }}>
              A dismissal reason is required — we never dismiss an action silently.
            </p>
            <SvTextArea
              aria-label="Dismissal reason"
              placeholder="Why is this action being dismissed?"
              rows={3}
              value={dismissReason}
              onChange={setDismissReason}
            />
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setDismissOpen(false)} disabled={updateStatus.isPending}>
                Cancel
              </CapiroButton>
              {/* Disabled while the PATCH is in flight so a double click cannot
                  fire a dismissed->dismissed transition (which 400s). */}
              <CapiroButton
                variant="primary"
                className="stv-btn-danger"
                disabled={!dismissReason.trim() || updateStatus.isPending}
                loading={updateStatus.isPending}
                onClick={submitDismiss}
              >
                Dismiss
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}
    </SvCard>
  );
}
