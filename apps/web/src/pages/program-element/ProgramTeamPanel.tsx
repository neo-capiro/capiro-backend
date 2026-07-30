import { Avatar, Button, Card, Empty, Skeleton, Tag, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import type { PersonRoleSummary } from './types.js';

const { Text, Link } = Typography;

export interface ProgramTeamPerson {
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
}

// contactUse → AntD Tag color. Procurement-sensitive / quarantined buckets read
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

export interface ProgramTeamPanelProps {
  personnel: ProgramTeamPerson[];
  loading?: boolean;
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

function confidenceBand(value: number): {
  label: 'high' | 'medium' | 'low';
  color: 'green' | 'gold' | 'default';
} {
  if (value >= 0.95) return { label: 'high', color: 'green' };
  if (value >= 0.8) return { label: 'medium', color: 'gold' };
  return { label: 'low', color: 'default' };
}

// Confidence rendered as a colored dot + words ("High confidence"), matching
// the mockup. Maps the band to a redesign severity class.
function confidenceDot(value: number): { cls: string; label: string } {
  const band = confidenceBand(value);
  if (band.label === 'high') return { cls: 'success', label: 'High confidence' };
  if (band.label === 'medium') return { cls: 'notable', label: 'Medium confidence' };
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

export function ProgramTeamPanel({
  personnel,
  loading = false,
  estimatedTotal: _estimatedTotalIgnored,
  onViewAllSources,
  onLinkCrmContact,
}: ProgramTeamPanelProps) {
  if (loading) {
    return (
      <Card title="Program team">
        <Skeleton active paragraph={{ rows: 5 }} />
      </Card>
    );
  }

  // Phase 5: show only identified personnel counts — never "~N known" fabrications.
  void _estimatedTotalIgnored;

  return (
    <Card
      className="pe-team-card"
      title="Program team"
      extra={
        <span className="pe-team-extra">
          <Text type="secondary" data-testid="pe-team-identified-count">
            {personnel.length === 1
              ? '1 identified person'
              : `${personnel.length} identified people`}
          </Text>
          <Link onClick={onViewAllSources}>View all sources →</Link>
        </span>
      }
    >
      {personnel.length === 0 ? (
        <Empty description="No team data found for this PE — log meeting contacts to build coverage" />
      ) : (
        <div className="pe-team-list pe-scroll-5">
          {personnel.map((person) => {
            const conf = confidenceDot(person.confidence);
            const meta = [person.title, person.organization].filter(Boolean).join(' · ');
            // Step 2.2: the role chain (role → office → program → PE). The primary
            // (first) role drives the contactUse badge + why-shown; any extras are
            // listed compactly. Empty/absent → legacy display + a pending note.
            // Defense-in-depth: the API already excludes quarantined roles, but
            // never render one even if it slips through (suspect data). Accepted +
            // candidate roles are shown; candidate is badged "requires review".
            const roles = Array.isArray(person.roles)
              ? person.roles.filter((r) => r.reviewStatus !== 'quarantined')
              : [];
            const primaryRole = roles[0] ?? null;
            const extraRoles = roles.slice(1);
            const primaryHost = primaryRole ? sourceHost(primaryRole) : null;
            return (
              <div className="pe-team-row" key={person.id}>
                <Avatar
                  className="pe-team-avatar"
                  src={person.headshotUrl ?? undefined}
                  style={{ background: avatarColor(person.fullName) }}
                >
                  {initials(person.fullName)}
                </Avatar>
                <div className="pe-team-id">
                  <div className="pe-team-name-row">
                    <span className="pe-team-name">{person.fullName}</span>
                    {person.role ? <span className="pe-role-pill">{person.role}</span> : null}
                  </div>
                  <div className="pe-team-sub">{meta || 'Title/organization unavailable'}</div>
                  {person.email ? (
                    <div className="pe-team-email">
                      <Link href={`mailto:${person.email}`}>{person.email}</Link>
                    </div>
                  ) : null}
                  {primaryRole ? (
                    <div className="pe-team-roles">
                      <div className="pe-team-role-head">
                        <Tag color={contactUseColor(primaryRole.contactUse)}>
                          {primaryRole.contactUseLabel}
                        </Tag>
                        {primaryRole.staleAt ? (
                          <Tag color="warning">Stale — verify before use</Tag>
                        ) : null}
                      </div>
                      <div className="pe-team-role-why">{primaryRole.whyShown}</div>
                      <div className="pe-team-role-seen">
                        Last observed {formatDate(primaryRole.observedAt)}
                        {primaryHost ? ` — ${primaryHost}` : ''}
                      </div>
                      {extraRoles.length > 0 ? (
                        <div className="pe-team-role-extra">
                          {extraRoles.map((r) => (
                            <Tag key={r.id} color={contactUseColor(r.contactUse)}>
                              {r.roleTitle} · {r.contactUseLabel}
                            </Tag>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="pe-team-role-pending">
                      <Text type="secondary">Role mapping pending review</Text>
                    </div>
                  )}
                </div>
                <div className="pe-team-conf">
                  <span className="pe-conf">
                    <i className={`dot ${conf.cls}`} />
                    {conf.label}
                  </span>
                  <span className="pe-team-seen">
                    Last seen {formatDate(person.lastSeenAt)} · {person.sourceCount} sources
                  </span>
                </div>
                <Button
                  className="pe-link-btn"
                  size="small"
                  icon={<ExportOutlined aria-hidden />}
                  onClick={() => onLinkCrmContact?.(person.id)}
                >
                  Link
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function confidencePillColor(value: number): 'green' | 'gold' | 'default' {
  return confidenceBand(value).color;
}
