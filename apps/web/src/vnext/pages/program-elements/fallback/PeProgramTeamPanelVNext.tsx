/**
 * Program team — native vNext port of
 * `pages/program-element/ProgramTeamPanel.tsx` (re-skin: identical props,
 * copy, PII gating, contact-use badge convention, CRM-link blocking).
 */
import type { PersonRoleSummary } from '../../../../pages/program-element/types.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { PeFbExportIcon } from './pe-fallback-icons.js';
import { PeFbEmpty, PeFbPanel, PeFbSecondaryFailed, PeFbSkeleton, PeFbTag } from './pe-fallback-ui.js';

export interface ProgramTeamPersonVNext {
  id: string;
  fullName: string;
  title: string | null;
  organization: string | null;
  role: string | null;
  confidence: number;
  lastSeenAt: string;
  sourceCount: number;
  headshotUrl?: string | null;
  // Full contact email. The API populates this ONLY for capiro_admin (PII gate);
  // for everyone else it is null/absent and no email line renders.
  email?: string | null;
  // Step 2.2 (plan §8): people hang off OFFICES and ROLES, never directly off a PE.
  // Empty/absent → render the legacy display + a muted "role mapping pending" note.
  roles?: PersonRoleSummary[];
  /** Server-derived PE-page CRM link gate. */
  crmLinkBlocked?: boolean;
  crmLinkBlockedReason?: string | null;
}

// contactUse → tag color. Procurement-sensitive / quarantined buckets read
// hot (red) so a user never mistakes them for a safe lobbying target; the actual
// procurement POC reads volcano (visible, but distinct from "do not contact").
const CONTACT_USE_TAG_COLOR: Record<string, string> = {
  official_procurement_poc: 'volcano',
  do_not_contact_procurement_sensitive: 'red',
  quarantined: 'red',
  candidate: 'default',
  program_ownership_context: 'blue',
  internal_owner: 'geekblue',
  relationship_owner: 'geekblue',
  lobbying_contact: 'green',
};

function contactUseColor(contactUse: string): string {
  return CONTACT_USE_TAG_COLOR[contactUse] ?? 'default';
}

// Best-effort host for the freshness line. The role summary carries no source URL
// in the current contract, so this is defensive: if a sourceUrl/source ever rides
// along we surface its host; otherwise the freshness line is just the date.
function sourceHost(role: PersonRoleSummary): string | null {
  const raw = (role as { sourceUrl?: string | null; source?: string | null }).sourceUrl;
  const fallback = (role as { source?: string | null }).source ?? null;
  if (raw) {
    try {
      return new URL(raw).host;
    } catch {
      return raw;
    }
  }
  return fallback;
}

export interface ProgramTeamPanelVNextProps {
  personnel: ProgramTeamPersonVNext[];
  loading?: boolean;
  /** True when the personnel query failed — must not look like empty roster. */
  errored?: boolean;
  onRetry?: () => void;
  /**
   * @deprecated Phase 5 — fabricated roster estimates removed. If provided and
   * larger than the identified roster, it is ignored so the UI never invents
   * headcount beyond identified personnel.
   */
  estimatedTotal?: number;
  onViewAllSources?: () => void;
  onLinkCrmContact?: (personId: string) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';

  const first = parts[0];
  if (!first) return '?';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();

  const last = parts[parts.length - 1] ?? first;
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

// Confidence rendered as a colored dot + words ("High confidence"), matching
// the mockup.
function confidenceDot(value: number): { cls: string; label: string } {
  if (value >= 0.95) return { cls: 'success', label: 'High confidence' };
  if (value >= 0.8) return { cls: 'notable', label: 'Medium confidence' };
  return { cls: 'muted', label: 'Low confidence' };
}

// Deterministic avatar background from the name so each person keeps a stable
// brand-ish color across renders.
const AVATAR_COLORS = ['#2a57ce', '#7a3fb5', '#2e6b43', '#a26913', '#b5301b', '#1a3f9f', '#4e78d8'];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]!;
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function PeProgramTeamPanelVNext({
  personnel,
  loading = false,
  errored = false,
  onRetry,
  estimatedTotal: _estimatedTotalIgnored,
  onViewAllSources,
  onLinkCrmContact,
}: ProgramTeamPanelVNextProps) {
  if (loading) {
    return (
      <PeFbPanel title="Program team">
        <PeFbSkeleton rows={5} />
      </PeFbPanel>
    );
  }

  if (errored) {
    return (
      <PeFbSecondaryFailed label="program team" testId="pe-secondary-failed-personnel" onRetry={onRetry} />
    );
  }

  // Phase 5: show only identified personnel counts — never "~N known" fabrications.
  void _estimatedTotalIgnored;

  return (
    <PeFbPanel
      className="pe-fb-team-card"
      title="Program team"
      extra={
        <span className="pe-fb-team-extra">
          <span className="pe-fb-muted" data-testid="pe-team-identified-count">
            {personnel.length === 1
              ? '1 identified person'
              : `${personnel.length} identified people`}
          </span>
          <button type="button" className="pe-fb-link-quiet" onClick={onViewAllSources}>
            View all sources →
          </button>
        </span>
      }
    >
      {personnel.length === 0 ? (
        <PeFbEmpty description="No team data found for this PE — log meeting contacts to build coverage" />
      ) : (
        <div className="pe-fb-team-list pe-fb-scroll">
          {personnel.map((person) => {
            const conf = confidenceDot(person.confidence);
            const meta = [person.title, person.organization].filter(Boolean).join(' · ');
            // Step 2.2: the role chain (role → office → program → PE). The primary
            // (first) role drives the contactUse badge + why-shown; any extras are
            // listed compactly. Defense-in-depth: the API already excludes quarantined
            // roles, but never render one even if it slips through (suspect data).
            const roles = Array.isArray(person.roles)
              ? person.roles.filter((r) => r.reviewStatus !== 'quarantined')
              : [];
            const primaryRole = roles[0] ?? null;
            const extraRoles = roles.slice(1);
            const primaryHost = primaryRole ? sourceHost(primaryRole) : null;
            const blocked = person.crmLinkBlocked === true;
            const reason =
              person.crmLinkBlockedReason?.trim() ||
              'CRM linking is blocked for this person on this Program Element.';
            return (
              <div className="pe-fb-team-row" key={person.id}>
                <span
                  className="pe-fb-team-avatar"
                  style={{ background: avatarColor(person.fullName) }}
                  aria-hidden="true"
                >
                  {person.headshotUrl ? (
                    <img src={person.headshotUrl} alt="" />
                  ) : (
                    initials(person.fullName)
                  )}
                </span>
                <div className="pe-fb-team-id">
                  <div className="pe-fb-team-name-row">
                    <span className="pe-fb-team-name">{person.fullName}</span>
                    {person.role ? <span className="pe-fb-role-pill">{person.role}</span> : null}
                  </div>
                  <div className="pe-fb-team-sub">{meta || 'Title/organization unavailable'}</div>
                  {person.email ? (
                    <div className="pe-fb-team-email">
                      <a href={`mailto:${person.email}`}>{person.email}</a>
                    </div>
                  ) : null}
                  {primaryRole ? (
                    <div className="pe-fb-team-roles">
                      <div className="pe-fb-team-role-head">
                        <PeFbTag color={contactUseColor(primaryRole.contactUse)}>
                          {primaryRole.contactUseLabel}
                        </PeFbTag>
                        {primaryRole.staleAt ? (
                          <PeFbTag color="warning">Stale — verify before use</PeFbTag>
                        ) : null}
                      </div>
                      <div className="pe-fb-team-role-why">{primaryRole.whyShown}</div>
                      <div className="pe-fb-team-role-seen">
                        Last observed {formatDate(primaryRole.observedAt)}
                        {primaryHost ? ` — ${primaryHost}` : ''}
                      </div>
                      {extraRoles.length > 0 ? (
                        <div className="pe-fb-team-role-extra">
                          {extraRoles.map((r) => (
                            <PeFbTag key={r.id} color={contactUseColor(r.contactUse)}>
                              {r.roleTitle} · {r.contactUseLabel}
                            </PeFbTag>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="pe-fb-team-role-pending">
                      <span className="pe-fb-muted">Role mapping pending review</span>
                    </div>
                  )}
                </div>
                <div className="pe-fb-team-conf">
                  <span className="pe-fb-conf">
                    <i className={`dot ${conf.cls}`} />
                    {conf.label}
                  </span>
                  <span className="pe-fb-team-seen">
                    Last seen {formatDate(person.lastSeenAt)} · {person.sourceCount} sources
                  </span>
                </div>
                <span
                  className="pe-fb-crm-link-wrap"
                  title={blocked ? reason : 'Link to CRM contact'}
                  data-testid={blocked ? `pe-crm-link-reason-${person.id}` : undefined}
                >
                  <CapiroButton
                    size="compact"
                    className="pe-fb-link-btn"
                    leadingIcon={<PeFbExportIcon />}
                    disabled={blocked || !onLinkCrmContact}
                    aria-disabled={blocked || !onLinkCrmContact}
                    aria-label={
                      blocked
                        ? `Link unavailable. ${reason}`
                        : `Link ${person.fullName} to CRM contact`
                    }
                    data-testid={
                      blocked ? `pe-crm-link-blocked-${person.id}` : `pe-crm-link-${person.id}`
                    }
                    onClick={() => {
                      if (!blocked) onLinkCrmContact?.(person.id);
                    }}
                  >
                    Link
                  </CapiroButton>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </PeFbPanel>
  );
}
