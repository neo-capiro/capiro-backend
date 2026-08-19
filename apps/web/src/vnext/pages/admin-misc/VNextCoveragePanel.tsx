/**
 * vNext re-skin of pages/actions/CoveragePanel.tsx — the Step 3.4
 * "Relationship coverage" sub-section hosted inside an action card. Identical
 * hooks (coverage-api.js reused verbatim), band semantics (strong/weak/none),
 * §17 contactUse badge convention, the context-only rule (outreachEligible !==
 * true rows never get an outreach control) and the actionable-gap rule
 * ('none' band or a 'cold' row, outreach-eligible only). Lazy-fetch gating is
 * owned by the parent via `enabled`, exactly like canonical.
 */
import { useState } from 'react';
import {
  useActionCoverage,
  useCreateOutreach,
  type CoverageEntry,
  type CoverageResult,
} from '../../../pages/actions/coverage-api.js';
import type { TeamMemberOption } from '../../../pages/actions/actions-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTooltip } from '../../components/menus/index.js';

// contactUse → badge tone. Mirrors the canonical CONTACT_USE_TAG_COLOR
// convention (CoveragePanel.tsx / ProgramTeamPanel.tsx): procurement-sensitive
// / quarantined buckets read hot (danger) so a user never mistakes one for a
// safe lobbying target; lobbying contacts read success; ownership context
// reads info.
const CONTACT_USE_TONE: Record<string, CapiroBadgeTone> = {
  official_procurement_poc: 'danger',
  do_not_contact_procurement_sensitive: 'danger',
  quarantined: 'danger',
  candidate: 'neutral',
  program_ownership_context: 'info',
  internal_owner: 'info',
  relationship_owner: 'info',
  lobbying_contact: 'success',
};

function contactUseTone(contactUse: string): CapiroBadgeTone {
  return CONTACT_USE_TONE[contactUse] ?? 'neutral';
}

function memberName(member: TeamMemberOption): string {
  const full = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return full || member.email || member.userId;
}

function formatTouch(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Per-band heading label + accent token (the row accent is CSS data-band). */
const BAND_META: Record<'strong' | 'weak' | 'none', { label: string; color: string }> = {
  strong: { label: 'Strong coverage', color: 'var(--capiro-color-success)' },
  weak: { label: 'Weak / stale', color: 'var(--capiro-color-warning)' },
  none: { label: 'Gaps — never engaged', color: 'var(--capiro-color-danger)' },
};

/** A stable key for a coverage row (officeId + personId — personId may be absent for office rows). */
function entryKey(entry: CoverageEntry, idx: number): string {
  return `${entry.officeId || 'office'}:${entry.personId ?? 'office-only'}:${idx}`;
}

function CoverageRow({
  entry,
  band,
  actionId,
  teamMembers,
}: {
  entry: CoverageEntry;
  band: 'strong' | 'weak' | 'none';
  actionId: string;
  teamMembers: TeamMemberOption[];
}) {
  const toast = useCapiroToast();
  const createOutreach = useCreateOutreach();
  const [ownerUserId, setOwnerUserId] = useState('');

  const members = Array.isArray(teamMembers) ? teamMembers : [];

  // An actionable gap is a 'none' or 'cold' row that is outreach-eligible. Strong rows and
  // any outreachEligible===false row are CONTEXT ONLY — they never show an outreach control.
  const isActionableGap =
    entry.outreachEligible === true && (band === 'none' || entry.strength === 'cold');

  function handleCreate() {
    if (!ownerUserId) return; // guarded; button is also disabled
    createOutreach.mutate(
      {
        actionId,
        officeId: entry.officeId,
        // Office-only rows (no personId) omit personId in the POST.
        ...(entry.personId ? { personId: entry.personId } : {}),
        ownerUserId,
      },
      {
        onSuccess: () => toast.success('Outreach assigned & created'),
        onError: (err) => toast.error(err.message || 'Could not create outreach'),
      },
    );
  }

  const meta = [entry.personName, entry.roleTitle].filter(Boolean).join(' · ');

  return (
    <div className="amx-coverage-row" data-band={band}>
      <div className="amx-coverage-row-main">
        <CapiroBadge tone={contactUseTone(entry.contactUse)}>
          {entry.contactUseLabel || entry.contactUse}
        </CapiroBadge>
        <span className="stv-strong">{entry.officeName || entry.officeId || 'Unknown office'}</span>
        {meta ? <span className="stv-muted stv-small">· {meta}</span> : null}
        {band === 'weak' ? (
          <CapiroTooltip content="Relationship has gone cold — verify before relying on it">
            <CapiroBadge tone="warning">stale</CapiroBadge>
          </CapiroTooltip>
        ) : null}
        {/* Context-only rows are clearly marked so a user never mistakes one for a target. */}
        {entry.outreachEligible !== true ? (
          <CapiroTooltip content="Context only — not an outreach/lobbying target">
            <span className="stv-muted stv-small">context</span>
          </CapiroTooltip>
        ) : null}
      </div>

      <div className="amx-coverage-row-meta">
        <span className="stv-muted stv-small">last touch {formatTouch(entry.lastTouch)}</span>
        {entry.owner ? <span className="stv-muted stv-small">owner: {entry.owner}</span> : null}
      </div>

      {isActionableGap ? (
        <div className="amx-coverage-row-action">
          <span style={{ minWidth: 170 }}>
            <CapiroSelect
              label="Assign owner"
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
              options={[
                {
                  value: '',
                  label: members.length ? 'Assign owner…' : 'No team members',
                  disabled: true,
                },
                ...members.map((m) => ({ value: m.userId, label: memberName(m) })),
              ]}
            />
          </span>
          <CapiroButton
            size="compact"
            variant="primary"
            loading={createOutreach.isPending}
            disabled={!ownerUserId || createOutreach.isPending}
            onClick={handleCreate}
          >
            Assign &amp; create outreach
          </CapiroButton>
        </div>
      ) : null}
    </div>
  );
}

function CoverageBand({
  band,
  entries,
  actionId,
  teamMembers,
}: {
  band: 'strong' | 'weak' | 'none';
  entries: CoverageEntry[];
  actionId: string;
  teamMembers: TeamMemberOption[];
}) {
  const rows = Array.isArray(entries) ? entries : [];
  if (!rows.length) return null;
  const meta = BAND_META[band];
  return (
    <div className="stv-stack stv-stack--tight">
      <div className="amx-coverage-band-head" style={{ color: meta.color }}>
        {meta.label} ({rows.length})
      </div>
      {rows.map((entry, idx) => (
        <CoverageRow
          key={entryKey(entry, idx)}
          entry={entry}
          band={band}
          actionId={actionId}
          teamMembers={teamMembers}
        />
      ))}
    </div>
  );
}

/**
 * The coverage body — rendered ONLY when the parent has expanded the section (it owns the
 * lazy-fetch gate via the `enabled` prop on the query). Renders loading / error / empty / data.
 */
export function VNextCoveragePanel({
  actionId,
  teamMembers,
  enabled,
}: {
  actionId: string;
  teamMembers: TeamMemberOption[];
  enabled: boolean;
}) {
  const { data, isLoading, isError, error } = useActionCoverage(actionId, enabled);

  if (isLoading) {
    return (
      <div className="amx-subsection-body" data-testid="coverage-panel" aria-label="Loading coverage">
        <CapiroSkeleton height={14} width="40%" />
        <CapiroSkeleton height={14} width="70%" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="amx-subsection-body" data-testid="coverage-panel">
        <span className="stv-danger-text">
          {(error as Error)?.message || 'Could not load relationship coverage.'}
        </span>
      </div>
    );
  }

  const result: CoverageResult | undefined = data;
  const strong = Array.isArray(result?.strong) ? result!.strong : [];
  const weak = Array.isArray(result?.weak) ? result!.weak : [];
  const none = Array.isArray(result?.none) ? result!.none : [];
  const hasAny = strong.length + weak.length + none.length > 0;

  return (
    <div className="amx-subsection-body" data-testid="coverage-panel">
      {result?.whyNow?.whatChanged ? (
        <span className="stv-muted stv-small">Why now: {result.whyNow.whatChanged}</span>
      ) : null}

      {hasAny ? (
        <>
          <CoverageBand band="strong" entries={strong} actionId={actionId} teamMembers={teamMembers} />
          <CoverageBand band="weak" entries={weak} actionId={actionId} teamMembers={teamMembers} />
          <CoverageBand band="none" entries={none} actionId={actionId} teamMembers={teamMembers} />
        </>
      ) : (
        <span className="stv-muted">No relationship-coverage data for this PE yet</span>
      )}
    </div>
  );
}
