import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  ContactRound,
  History,
  Loader2,
  Mail,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { useApi } from '../../../../lib/use-api.js';
import {
  addTargetCommand,
  rejectTargetRecommendationCommand,
  removeTargetCommand,
  targetCriteriaCommand,
} from './commands.js';
import type { DecisionSurfacesProps } from './DecisionSurfaces.js';
import { TargetDirectoryBrowser } from './TargetDirectoryBrowser.js';
import type {
  OutreachV3ResolvedTargetRef,
  OutreachV3TargetCandidate,
  OutreachV3TargetLocator,
  OutreachV3TargetSignal,
} from './contracts.js';
import {
  getOutreachV3TargetRelationships,
  safeOutreachV3Error,
} from './outreach-v3-api.js';
import type {
  OutreachV3RelationshipResponse,
  OutreachV3TargetProfileResponse,
  OutreachV3TargetProfileSection,
} from './target-intelligence-contracts.js';
// Saved Audiences (item 4): the real, already-wired read endpoint. Living in
// vnext's engagement-api.ts rather than this folder's own outreach-v3-api.ts
// is the shared file's existing home for it, per the phase brief — it is a
// plain stateless (api) => Promise<SavedAudience[]> call with no vnext-only
// coupling, so importing it here does not tie this shared component to
// anything vnext-specific.
import {
  listSavedOutreachAudiences,
  type SavedAudience,
  type SavedAudienceMember,
} from '../../../../vnext/pages/engagement/engagement-api.js';

export type TargetWorkspaceProps = Pick<
  DecisionSurfacesProps,
  | 'session'
  | 'busy'
  | 'applyCommands'
  | 'searchTargets'
  | 'targetCandidates'
  | 'targetSearchPending'
  | 'targetSearchError'
  | 'getTargetProfile'
  | 'targetProfile'
  | 'targetProfilePending'
  | 'coverage'
  | 'coveragePending'
> &
  Pick<Partial<DecisionSurfacesProps>, 'targetsVariant'>;

type TargetSourceKey =
  | 'recommended'
  | 'directory'
  | 'statelegislators'
  | 'client'
  | 'recent'
  | 'selected'
  | 'saved'
  | 'manual';

/**
 * `directory` carries NO capability sources: it is served by
 * `TargetDirectoryBrowser`, which reads `GET /api/directory/contacts` exactly
 * as Outreach V2's Directory tab does. It previously ran the governed
 * `search_targets` capability over
 * `['directory_member', 'directory_staff', 'state_legislator']` with
 * `limit: 20` — one merged, score-ranked, 20-row pool, so most of the
 * Directory was simply unreachable and state legislators competed with
 * members for the same 20 slots.
 *
 * `state_legislator` therefore moved to its own tab, still on the capability
 * (there is no V2-style browse endpoint wired here for it, and it has no
 * staffer nesting or favorites store of its own).
 */
const SOURCE_OPTIONS: Array<{
  key: TargetSourceKey;
  label: string;
  sources: string[];
  requiresClient?: boolean;
}> = [
  { key: 'recommended', label: 'Recommended', sources: [] },
  { key: 'directory', label: 'Directory', sources: [] },
  { key: 'statelegislators', label: 'State legislators', sources: ['state_legislator'] },
  {
    key: 'client',
    label: 'Client contacts',
    sources: ['client_person', 'client_recommendation'],
    requiresClient: true,
  },
  { key: 'saved', label: 'Saved audiences', sources: [] },
  {
    key: 'recent',
    label: 'Recent',
    sources: ['engagement_contact'],
    requiresClient: true,
  },
  { key: 'manual', label: 'Add manually', sources: [] },
  { key: 'selected', label: 'Selected', sources: [] },
];

/** Tabs that render their own surface instead of the capability card list. */
const NON_CAPABILITY_SOURCES = new Set<TargetSourceKey>([
  'directory',
  'selected',
  'saved',
  'manual',
]);

/**
 * Mirrors GA_AUDIENCES in government-affairs-policy.registry.ts. A manual
 * target has no directory/domain signal for that registry's selectPolicy()
 * to resolve on its own, so it fails closed (OUTREACH_COMMAND_BLOCKED,
 * "audience_policy_required") at sample generation unless the person adding
 * it says which audience this is. The blank option is a placeholder ONLY —
 * addManual() refuses to submit while it's selected, so this can no longer
 * be added and discovered as broken only at generation time.
 */
const MANUAL_AUDIENCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Choose one\u2026' },
  { value: 'congressional_office', label: 'Federal congressional office' },
  { value: 'federal_agency', label: 'Federal agency' },
  { value: 'defense_acquisition_office', label: 'Defense acquisition office' },
  { value: 'state_legislator', label: 'State legislator' },
  { value: 'state_agency', label: 'State agency' },
  { value: 'local_official', label: 'Local official' },
  { value: 'coalition', label: 'Coalition partner' },
  { value: 'client_executive', label: 'Client executive' },
  { value: 'internal_colleague', label: 'Internal colleague' },
];

/**
 * Resolves one saved-audience member into the same locator shape every other
 * target source uses. Prefers the member's real backing source/ref (so the
 * backend re-resolves it the same way a Directory/Client-contact pick does);
 * falls back to a manual-style locator built from the member's own fields
 * when it has no resolvable source ref, mirroring how the Manual tab already
 * builds a locator for a hand-entered target.
 */
export function savedAudienceMemberLocator(member: SavedAudienceMember): OutreachV3TargetLocator {
  if (member.sourceRefId) {
    return {
      source: member.source,
      id: member.sourceRefId,
      name: member.name,
      email: member.email || null,
      title: member.title,
      organization: member.office,
    };
  }
  return {
    source: 'manual',
    id: member.id,
    name: member.name || member.email,
    email: member.email || null,
    phone: null,
    title: member.title ?? null,
    organization: member.office ?? null,
    note: null,
  };
}

/**
 * Best-effort tone mapping for candidate signals. The backend contract
 * (`OutreachV3TargetSignal`) only carries `{ code, label }` — no tone hint —
 * and `committee_match` (used in this file's own test fixture) is the only
 * real signal code confirmed anywhere in the frontend. Everything else is a
 * conservative keyword heuristic over `code`/`label`, defaulting to gray per
 * the phase brief, rather than a fabricated exhaustive enum.
 */
function signalPillTone(signal: OutreachV3TargetSignal): 'eng-pill--navy' | 'eng-pill--warn' | 'eng-pill--gray' {
  const key = `${signal.code} ${signal.label}`.toLowerCase();
  if (/risk|stale|missing|gap|conflict|warn|blocker/.test(key)) return 'eng-pill--warn';
  if (/match|relationship|existing|verified|confirmed|current/.test(key)) return 'eng-pill--navy';
  return 'eng-pill--gray';
}

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Send-readiness is a FOUR-condition server predicate, not an email check.
 * `deriveTargetCoverage` (apps/api/src/capabilities/targets/target-coverage.ts)
 * computes, per selected target:
 *
 *   readyForSending = emailStatus === 'available' && roleStatus === 'current'
 *     && profileStatus !== 'unavailable' && !duplicateEmail
 *
 * and `sendReadyCount` — the number the Audience coverage meter shows — is
 * just how many of those came back true. The per-target rows used to test
 * `emailStatus === 'available'` alone and print "Email ready", so a target
 * with an email but a HISTORICAL role read as ready while the meter directly
 * beneath it counted zero. Everything below exists so both read one verdict.
 *
 * `PROFILE_LIMITED` is deliberately absent: the server reports it as health
 * but it does NOT block sending (only `profileStatus === 'unavailable'`
 * does), so listing it as a reason would claim a blocker the meter never
 * counted. `short` is for the aggregate coverage line, `detail` for the row.
 */
const SEND_BLOCKERS: Record<string, { short: string; detail: string }> = {
  EMAIL_MISSING: { short: 'no email', detail: 'No email address on file' },
  EMAIL_INVALID: { short: 'unusable email', detail: 'The email address on file is not usable' },
  ROLE_HISTORICAL: { short: 'former role', detail: 'Former role — no longer in this office' },
  ROLE_UNKNOWN: { short: 'role unconfirmed', detail: 'The current role could not be confirmed' },
  PROFILE_UNAVAILABLE: { short: 'profile unavailable', detail: 'The directory profile is unavailable' },
  DUPLICATE_EMAIL: {
    short: 'duplicate email',
    detail: 'Shares an email address with another selected target',
  },
};

/**
 * `ready` and `blocked` are proven states. `unknown` means a condition of the
 * server predicate genuinely is not knowable from what this surface holds —
 * it is never a polite way of saying "probably fine", and it is never counted
 * toward the meter.
 */
type SendReadiness = {
  state: 'ready' | 'blocked' | 'unknown';
  /** Blocking health codes, as returned by the coverage endpoint. */
  codes: string[];
  /** Explanation for a state no health code accounts for. */
  note: string | null;
};

const SEND_READINESS_LABELS: Record<SendReadiness['state'], string> = {
  ready: 'Send ready',
  blocked: 'Not send-ready',
  unknown: 'Readiness unknown',
};

const READY: SendReadiness = { state: 'ready', codes: [], note: null };
const UNKNOWN: SendReadiness = { state: 'unknown', codes: [], note: null };

function blocked(codes: string[]): SendReadiness {
  // A false `readyForSending` with no recognized blocking code would otherwise
  // render as a bare "Not send-ready" with nothing to act on.
  return codes.length
    ? { state: 'blocked', codes, note: null }
    : { state: 'blocked', codes: [], note: 'The blocking condition was not reported' };
}

/** Every reason line to show under a target row, in server code order. */
function readinessReasons(readiness: SendReadiness): string[] {
  const fromCodes = readiness.codes.map((code) => SEND_BLOCKERS[code]?.detail ?? sentence(code));
  return readiness.note ? [...fromCodes, readiness.note] : fromCodes;
}

/**
 * Per-target health rows from
 * `GET …/targets/coverage` → `coverage.health` (`TargetHealthResultV1`).
 *
 * The shared `OutreachV3TargetCoverageResponse` declares only the aggregate
 * counters plus an `unknown` index signature, so the rows are narrowed here
 * rather than by widening a contract two other surfaces also consume. Using
 * the server's own rows — instead of re-deriving readiness — is what makes the
 * badges and the meter provably consistent: they are the same numbers.
 */
function coverageHealth(
  coverage: TargetWorkspaceProps['coverage'],
): Array<{ targetKey: string; readyForSending: boolean; codes: string[] }> | null {
  const rows = coverage?.coverage.health;
  if (!Array.isArray(rows)) return null;
  const parsed: Array<{ targetKey: string; readyForSending: boolean; codes: string[] }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { targetKey, readyForSending, healthCodes } = row as Record<string, unknown>;
    if (typeof targetKey !== 'string' || typeof readyForSending !== 'boolean') continue;
    parsed.push({
      targetKey,
      readyForSending,
      codes: (Array.isArray(healthCodes) ? healthCodes : []).filter(
        (code): code is string => typeof code === 'string' && code in SEND_BLOCKERS,
      ),
    });
  }
  return parsed;
}

/**
 * Groups the selected targets that share an email address, exactly as
 * `duplicatesByEmail` does server-side — same `email?.toLowerCase()` key, no
 * trimming — so the two can never disagree about who is a duplicate.
 */
function duplicateEmailKeys(selected: readonly OutreachV3ResolvedTargetRef[]): Set<string> {
  const byEmail = new Map<string, string[]>();
  for (const target of selected) {
    const email = target.email?.toLowerCase();
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) ?? []), target.targetKey]);
  }
  return new Set([...byEmail.values()].filter((keys) => keys.length > 1).flat());
}

/**
 * Mirrors the server predicate over a selected target, used only until the
 * coverage response for the current spec lands (and for a target the response
 * has no row for). It is an exact mirror rather than an approximation because
 * `deriveTargetCoverage` reads the very same `selectedTargetRefs` this
 * component holds — same inputs, same four conditions — so a badge never has
 * to flip its verdict when coverage arrives.
 */
function selectedReadiness(
  target: OutreachV3ResolvedTargetRef,
  duplicates: Set<string>,
): SendReadiness {
  const codes: string[] = [];
  if (target.emailStatus === 'missing') codes.push('EMAIL_MISSING');
  if (target.emailStatus === 'invalid') codes.push('EMAIL_INVALID');
  if (target.roleStatus === 'historical') codes.push('ROLE_HISTORICAL');
  if (target.roleStatus === 'unknown') codes.push('ROLE_UNKNOWN');
  if (target.profileStatus === 'unavailable') codes.push('PROFILE_UNAVAILABLE');
  if (duplicates.has(target.targetKey)) codes.push('DUPLICATE_EMAIL');
  if (codes.length) return blocked(codes);
  // `emailStatus` is required by the server contract but OPTIONAL on this
  // one, so an absent value has to be handled. The server would read the same
  // absent field and score `emailStatus === 'available'` false, so this is not
  // send-ready — but it is not a named blocker either, so it reports unknown
  // rather than inventing a "ready" the meter would not agree with.
  if (target.emailStatus !== 'available') {
    return { state: 'unknown', codes: [], note: 'No email status was reported for this target' };
  }
  return READY;
}

/**
 * A search result is not a selected target: `TargetCandidateV1` carries no
 * `profileStatus`, and duplicate detection is a property of the SELECTED set,
 * so two of the four server conditions are unknowable here. A candidate can
 * therefore be proven NOT ready but never proven ready — it reports unknown
 * instead of claiming readiness. An already-selected candidate is resolved
 * from the coverage rows instead, so both lists say the same thing about the
 * same person.
 */
function candidateReadiness(candidate: OutreachV3TargetCandidate): SendReadiness {
  const codes: string[] = [];
  if (candidate.emailStatus !== 'available') codes.push('EMAIL_MISSING');
  if (candidate.roleStatus === 'historical') codes.push('ROLE_HISTORICAL');
  if (candidate.roleStatus === 'unknown') codes.push('ROLE_UNKNOWN');
  if (codes.length) return blocked(codes);
  return {
    state: 'unknown',
    codes: [],
    note: 'Email on file and role current; the profile and duplicate-email checks run once this target is added',
  };
}

/** "former role (2) · no email (1)", most frequent first. */
function blockerSummary(readiness: readonly SendReadiness[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of readiness) {
    for (const code of entry.codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => `${SEND_BLOCKERS[code]?.short ?? sentence(code)} (${count})`);
}

/**
 * The one row-level readiness element. Its `title` carries the reasons even
 * where the surrounding card has no room for a reason line.
 */
function ReadinessCell({ readiness }: { readiness: SendReadiness }) {
  const reasons = readinessReasons(readiness);
  return (
    <span title={reasons.length ? reasons.join(' · ') : undefined}>
      {SEND_READINESS_LABELS[readiness.state]}
    </span>
  );
}

function PanelHeader({ selectedCount }: { selectedCount: number }) {
  return (
    <header className="ov3-panel-header">
      <div>
        <span className="ov3-eyebrow">Targets · 2 of 6</span>
        <h2>Choose the people and offices to contact</h2>
        <p>
          Search authorized sources, inspect role and relationship health, and add every target
          explicitly.
        </p>
      </div>
      <span className="ov3-badge is-success">{selectedCount} selected</span>
    </header>
  );
}

function ErrorNotice({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="ov3-recovery is-danger" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div><strong>This action could not complete</strong><p>{message}</p></div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  multiline,
  required,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email';
  multiline?: boolean;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="ov3-field">
      <span>{label}{required ? <em>Required</em> : null}</span>
      {options ? (
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value || 'unset'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : multiline ? (
        <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function StatusPill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}) {
  return <span className={cx('ov3-badge', tone !== 'neutral' && `is-${tone}`)}>{children}</span>;
}

function ProfileSection({
  label,
  section,
}: {
  label: string;
  section: OutreachV3TargetProfileSection;
}) {
  return (
    <div className="ov3-target-intel-section">
      <div>
        <span className="ov3-section-label">{label}</span>
        <StatusPill tone={section.status === 'available' ? 'success' : 'neutral'}>
          {sentence(section.status)}
        </StatusPill>
      </div>
      {section.values.length ? (
        <p>{section.values.join(' · ')}</p>
      ) : (
        <p className="ov3-muted-copy">{section.reason ?? 'No verified values are available.'}</p>
      )}
    </div>
  );
}

/**
 * Item 4 — Saved Audiences is a source of targets, never a delivery mode:
 * picking an audience just resolves its members into the same
 * selected-target list every other source (Directory, Client contacts,
 * manual entry) populates. Real data end to end — `listSavedOutreachAudiences`
 * already returns actual audiences; this was previously a hard-disabled tab
 * with no body at all.
 */
function SavedAudiencesPanel({
  audiences,
  pending,
  error,
  busy,
  onAddAll,
}: {
  audiences: SavedAudience[];
  pending: boolean;
  error?: string | null;
  busy: boolean;
  onAddAll: (audience: SavedAudience) => void;
}) {
  return (
    <div className="ov3-card-list">
      <p className="ov3-muted-copy">
        Reusable audiences are a source of targets, never a delivery mode. Adding an audience
        resolves each member into the same target list.
      </p>
      {pending ? (
        <div className="ov3-loading-list" aria-label="Loading saved audiences">
          <span />
          <span />
        </div>
      ) : error ? (
        <div className="ov3-recovery is-danger" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Saved audiences could not load</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : !audiences.length ? (
        <div className="ov3-empty-state">
          <UsersRound size={24} aria-hidden="true" />
          <strong>No saved audiences yet</strong>
          <p>Reusable audiences appear here once one is saved from a prior campaign.</p>
        </div>
      ) : (
        audiences.map((audience) => {
          // "Updated" has no real backing field on SavedAudience/
          // SavedAudienceMember (no timestamp anywhere in the contract) — a
          // date here would be fabricated, so this shows a real, computed
          // line instead. See phase report.
          //
          // This counts EMAIL PRESENCE, not send-readiness, and says so:
          // `SavedAudienceMember` carries no role, profile, or duplicate
          // information, and an audience member is not a selected target, so
          // three of the four conditions behind `sendReadyCount` cannot be
          // evaluated here at all. It previously read "N of M email-ready",
          // which invited exactly the comparison it cannot support.
          const withEmail = audience.members.filter((member) => Boolean(member.email)).length;
          return (
            <article key={audience.id} className="ov3-target-card">
              <header>
                <span className="ov3-avatar">{audience.name.slice(0, 2).toUpperCase()}</span>
                <div>
                  <strong>{audience.name}</strong>
                  <p>
                    {sentence(audience.kind)} · {withEmail} of {audience.members.length} with an
                    email address
                  </p>
                </div>
                <span className="eng-pill eng-pill--navy" aria-label={`${audience.members.length} members`}>
                  {audience.members.length}
                </span>
              </header>
              <footer>
                <span />
                <button
                  type="button"
                  className="ov3-button is-primary"
                  disabled={busy || !audience.members.length}
                  onClick={() => onAddAll(audience)}
                >
                  Add all
                </button>
              </footer>
            </article>
          );
        })
      )}
    </div>
  );
}

export function TargetWorkspace(props: TargetWorkspaceProps) {
  const {
    session,
    busy,
    applyCommands,
    searchTargets,
    targetCandidates,
    targetSearchPending,
    targetSearchError,
    getTargetProfile,
    targetProfile,
    targetProfilePending,
    coverage,
    coveragePending,
    targetsVariant = 'full',
  } = props;
  const compact = targetsVariant === 'compact';
  const api = useApi();
  const selected = session.spec.targeting.selectedTargetRefs;
  const sponsorClientId =
    session.spec.sponsor.kind === 'client' && session.spec.sponsor.clientRefs.length === 1
      ? session.spec.sponsor.clientRefs[0]?.clientId ?? null
      : null;
  const [source, setSource] = useState<TargetSourceKey>('recommended');
  const [query, setQuery] = useState(
    session.spec.targeting.criteria?.notes ?? session.spec.goal.topic ?? '',
  );
  const [relationshipPreference, setRelationshipPreference] = useState<
    'any' | 'existing' | 'new' | 'mixed'
  >(session.spec.targeting.criteria?.relationshipPreference ?? 'any');
  const [includeStaff, setIncludeStaff] = useState(
    session.spec.targeting.criteria?.includeStaff ?? true,
  );
  const [includePrincipals, setIncludePrincipals] = useState(
    session.spec.targeting.criteria?.includePrincipals ?? true,
  );
  const [error, setError] = useState<string | null>(null);
  const [activeLocator, setActiveLocator] = useState<OutreachV3TargetLocator | null>(null);
  const [manual, setManual] = useState({
    name: '',
    email: '',
    title: '',
    organization: '',
    note: '',
    audienceType: '',
  });
  // Holds the live query for the tab-load effect without making that effect
  // rerun per keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;

  const profile = targetProfile as OutreachV3TargetProfileResponse | undefined;
  const profileData = profile?.data;
  const profileTarget = profileData?.target;
  const profileStatus = profile?.selectionSnapshot.status;

  const relationships = useMutation({
    mutationFn: async (input: { locator: OutreachV3TargetLocator; clientId: string }) =>
      getOutreachV3TargetRelationships(
        api,
        session.session.id,
        input.locator,
        input.clientId,
      ),
  });

  // Item 4: only fetched once the Saved audiences tab is actually opened.
  const savedAudiences = useQuery({
    queryKey: ['outreach-v3', 'saved-audiences'],
    queryFn: () => listSavedOutreachAudiences(api),
    enabled: source === 'saved',
    staleTime: 30_000,
  });

  const selectedByKey = useMemo(
    () => new Map(selected.map((target) => [target.targetKey, target])),
    [selected],
  );
  const visibleCandidates = useMemo(() => {
    // A tab with its own surface must never inherit the last capability
    // result — the Directory browser owns its own rows.
    if (NON_CAPABILITY_SOURCES.has(source)) return [];
    return targetCandidates;
  }, [source, targetCandidates]);
  const highConfidence = useMemo(
    () => visibleCandidates.filter(
      (candidate) => candidate.score >= 0.75 && !selectedByKey.has(candidate.targetKey),
    ),
    [selectedByKey, visibleCandidates],
  );

  const criteriaCommand = () =>
    targetCriteriaCommand({
      notes: query,
      governmentLevels: ['federal', 'state'],
      relationshipPreference,
      includeStaff,
      includePrincipals,
    });

  const selectedOption = () => SOURCE_OPTIONS.find((entry) => entry.key === source);

  const targetSearchInput = (option: (typeof SOURCE_OPTIONS)[number]) => ({
    query: query.trim() || undefined,
    clientId:
      source === 'recommended' || option.requiresClient
        ? sponsorClientId ?? undefined
        : undefined,
    sources: [...option.sources],
    limit: 20,
  });

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const option = selectedOption();
    if (!option || NON_CAPABILITY_SOURCES.has(source)) return;
    if (option.requiresClient && !sponsorClientId) {
      setError('This source requires one explicit client sponsor.');
      return;
    }
    setError(null);
    try {
      // Search is an explicit commit point for the edited criteria. Merely
      // entering the stage never mutates the canonical Campaign Spec.
      await applyCommands([criteriaCommand()]);
      await searchTargets(targetSearchInput(option));
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  // Load the rows for whichever capability-backed tab is open — on mount, and
  // again on every tab switch.
  //
  // Without the tab-switch half of this, `targetCandidates` still held the
  // PREVIOUS tab's result, so opening e.g. State legislators showed Client
  // contacts rows under a State-legislators heading until you pressed Search.
  // Read-only: this never calls applyCommands, so merely opening a tab cannot
  // commit inferred target criteria to the canonical Campaign Spec — same rule
  // the mount-time recommendation load already followed.
  useEffect(() => {
    const option = SOURCE_OPTIONS.find((entry) => entry.key === source);
    if (!option || NON_CAPABILITY_SOURCES.has(source)) return;
    if (option.requiresClient && !sponsorClientId) return;
    void searchTargets({
      query: queryRef.current.trim() || undefined,
      clientId: source === 'recommended' || option.requiresClient
        ? sponsorClientId ?? undefined
        : undefined,
      sources: [...option.sources],
      limit: 20,
    }).catch((caught) => setError(safeOutreachV3Error(caught)));
    // `query` is deliberately NOT a dependency: it changes on every keystroke,
    // and searching per keystroke is what the Search control exists to avoid.
    // The current value is read through a ref instead.
  }, [searchTargets, source, sponsorClientId]);

  const openProfile = async (locator: OutreachV3TargetLocator) => {
    setActiveLocator(locator);
    relationships.reset();
    setError(null);
    try {
      await getTargetProfile(locator);
      if (sponsorClientId) {
        void relationships.mutateAsync({ locator, clientId: sponsorClientId }).catch(() => undefined);
      }
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const addCandidate = async (candidate: OutreachV3TargetCandidate) => {
    setError(null);
    try {
      await applyCommands([addTargetCommand(candidate)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const addHighConfidence = async () => {
    if (!highConfidence.length) return;
    setError(null);
    try {
      await applyCommands(highConfidence.map(addTargetCommand));
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const removeTarget = async (targetKey: string) => {
    setError(null);
    try {
      await applyCommands([removeTargetCommand(targetKey)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const dismissCandidate = async (candidate: OutreachV3TargetCandidate) => {
    setError(null);
    try {
      await applyCommands([
        rejectTargetRecommendationCommand({
          recommendationRef: candidate.recommendationRef,
          targetKey: candidate.targetKey,
        }),
      ]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const addAudience = async (audience: SavedAudience) => {
    if (!audience.members.length) return;
    setError(null);
    try {
      await applyCommands(
        audience.members.map((member) => addTargetCommand(savedAudienceMemberLocator(member))),
      );
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const addManual = async () => {
    if (!manual.name.trim()) {
      setError('Enter the target name.');
      return;
    }
    if (manual.email.trim() && !validEmail(manual.email.trim())) {
      setError('Enter a valid email address or leave the email blank.');
      return;
    }
    if (!manual.audienceType) {
      // A manual target has no directory/domain signal for
      // government-affairs-policy.registry's selectPolicy() to key off, so
      // adding one with no audience type would only surface as a much later,
      // harder-to-diagnose OUTREACH_COMMAND_BLOCKED at Generate — refuse it
      // here instead, at the moment the person can actually fix it.
      setError('Choose an audience type — Capiro will not guess government-affairs etiquette.');
      return;
    }
    const locator: OutreachV3TargetLocator = {
      source: 'manual',
      id: crypto.randomUUID(),
      name: manual.name.trim(),
      email: manual.email.trim() || null,
      phone: null,
      title: manual.title.trim() || null,
      organization: manual.organization.trim() || null,
      note: manual.note.trim() || null,
      audienceType: manual.audienceType,
    };
    setError(null);
    try {
      await applyCommands([addTargetCommand(locator)]);
      setManual({ name: '', email: '', title: '', organization: '', note: '', audienceType: '' });
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const activeSelected = activeLocator
    ? selected.find(
        (target) =>
          target.locator.source === activeLocator.source && target.locator.id === activeLocator.id,
      )
    : undefined;
  const relationship = relationships.data as OutreachV3RelationshipResponse | undefined;
  const snapshotChanged = profile?.selectionSnapshot.status === 'changed';

  /**
   * ONE readiness verdict per selected target, shared by the per-target rows
   * and by the Audience coverage meter below them.
   *
   * The server rows are authoritative, and are trusted only while
   * `coverage.specHash` still describes the current spec — a response for an
   * older spec is about a different selection. Rows the response does not
   * cover (a target added since it was issued) fall back to the exact local
   * mirror of the same predicate. Because every consumer reads this one map,
   * a row can no longer claim readiness the meter does not count.
   */
  const readinessByKey = useMemo(() => {
    const duplicates = duplicateEmailKeys(selected);
    const map = new Map<string, SendReadiness>(
      selected.map((target) => [target.targetKey, selectedReadiness(target, duplicates)]),
    );
    const rows = coverage?.specHash === session.specHash ? coverageHealth(coverage) : null;
    for (const row of rows ?? []) {
      if (!map.has(row.targetKey)) continue;
      map.set(row.targetKey, row.readyForSending ? READY : blocked(row.codes));
    }
    return map;
  }, [coverage, selected, session.specHash]);

  /**
   * `selected.length` rather than `coverage.coverage.selectedCount`: the
   * server counts the same array this component holds, so the two are equal by
   * construction, and reading the local one removes a way for the header count
   * and the meter to disagree while a coverage response is in flight.
   *
   * The old `??` fallbacks here were the second half of the reported defect —
   * `coverage.sendReadyCount` and `selected.filter(t => Boolean(t.email))`
   * measure different things, so the meter changed meaning depending on
   * whether the response had landed, and a server-returned 0 is not nullish so
   * the fallback could never reconcile them anyway.
   */
  const selectedReadinessList = useMemo(
    // The map is seeded from `selected`, so the fallback is unreachable; it
    // resolves to unknown rather than ready so no future change to the map can
    // make an absent verdict count toward the meter.
    () => selected.map((target) => readinessByKey.get(target.targetKey) ?? UNKNOWN),
    [readinessByKey, selected],
  );
  const sendReadyCount = selectedReadinessList.filter((entry) => entry.state === 'ready').length;
  const notSendReadyCount = selected.length - sendReadyCount;
  const coverageBlockers = blockerSummary(selectedReadinessList);

  return (
    <section
      className={`ov3-decision-panel ov3-target-workspace${compact ? ' is-compact' : ''}`}
    >
      <PanelHeader selectedCount={selected.length} />

      <div className="ov3-tab-row" role="tablist" aria-label="Target sources">
        {SOURCE_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={source === option.key}
            className={source === option.key ? 'is-selected' : ''}
            onClick={() => {
              setSource(option.key);
              setError(null);
            }}
          >
            {option.label}
            {option.key === 'selected' ? ` · ${selected.length}` : ''}
          </button>
        ))}
      </div>

      {/* The shared query field and criteria row belong to the capability
          search. A tab with its own surface (Directory, Selected, Saved, Add
          manually) is HIDDEN rather than merely disabled: leaving a greyed-out
          second search box stacked above the Directory's own search field made
          it read as a broken control. */}
      <div className="ov3-target-criteria" hidden={NON_CAPABILITY_SOURCES.has(source)}>
        <form className="ov3-search-bar" onSubmit={runSearch}>
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names, committees, offices, states, or issue areas"
            aria-label="Search targets"
            disabled={NON_CAPABILITY_SOURCES.has(source)}
          />
          {/* UI-parity §8.2: the compact variant has no standalone Search
              button — the field alone is the control, submitted with Enter,
              and the pending spinner moves inside it. */}
          {compact ? (
            targetSearchPending ? (
              <Loader2 className="ov3-spin" size={16} aria-label="Searching" />
            ) : null
          ) : (
            <button
              className="ov3-button is-secondary"
              type="submit"
              disabled={targetSearchPending || NON_CAPABILITY_SOURCES.has(source)}
            >
              {targetSearchPending ? <Loader2 className="ov3-spin" size={16} /> : null}
              Search
            </button>
          )}
        </form>
        <div className="ov3-target-criteria__controls" aria-label="Target criteria">
          {/* UI-parity §8.2: Staff / Principals / Relationship preference do
              not exist in the prototype — filtering is by source tab and
              query. Under `compact` the spec's includeStaff /
              includePrincipals / relationshipPreference keep their current
              session values and are not editable from this surface. */}
          {!compact && (
            <>
              <button
                type="button"
                className={includeStaff ? 'is-selected' : ''}
                aria-pressed={includeStaff}
                onClick={() => setIncludeStaff((value) => !value)}
              >
                Staff
              </button>
              <button
                type="button"
                className={includePrincipals ? 'is-selected' : ''}
                aria-pressed={includePrincipals}
                onClick={() => setIncludePrincipals((value) => !value)}
              >
                Principals
              </button>
              <label>
                <span className="sr-only">Relationship preference</span>
                <select
                  value={relationshipPreference}
                  onChange={(event) =>
                    setRelationshipPreference(
                      event.target.value as 'any' | 'existing' | 'new' | 'mixed',
                    )
                  }
                >
                  <option value="any">Any relationship</option>
                  <option value="existing">Existing relationships</option>
                  <option value="new">New relationships</option>
                  <option value="mixed">Mixed audience</option>
                </select>
              </label>
            </>
          )}
          {source === 'recommended' && highConfidence.length > 0 ? (
            <button
              type="button"
              className="ov3-button is-primary"
              disabled={busy}
              onClick={() => void addHighConfidence()}
            >
              Add {highConfidence.length} high-confidence
            </button>
          ) : null}
        </div>
      </div>

      {/* UI-parity §8.4: under `compact` this stacks to a single column so the
          target profile becomes a full-width card BELOW the list, rather than
          a narrow right rail beside it. */}
      <div className="ov3-work-grid is-targets">
        <div className="ov3-target-column">
          {source === 'manual' ? (
            <section className="ov3-manual-entry">
              <header>
                <div>
                  <span className="ov3-section-label">Manual target</span>
                  <p>
                    Adds the target to this campaign only. Saving to the shared Directory remains
                    off.
                  </p>
                </div>
                <StatusPill tone="info">Campaign only</StatusPill>
              </header>
              <div className="ov3-field-grid">
                <Field label="Name" required value={manual.name} onChange={(name) => setManual({ ...manual, name })} />
                <Field label="Email" type="email" value={manual.email} onChange={(email) => setManual({ ...manual, email })} />
                <Field label="Title" value={manual.title} onChange={(title) => setManual({ ...manual, title })} />
                <Field label="Organization" value={manual.organization} onChange={(organization) => setManual({ ...manual, organization })} />
                <Field
                  label="Audience type"
                  required
                  value={manual.audienceType}
                  onChange={(audienceType) => setManual({ ...manual, audienceType })}
                  options={MANUAL_AUDIENCE_OPTIONS}
                />
              </div>
              <p className="ov3-muted-copy">
                Capiro applies different government-affairs etiquette by audience and will not guess.
                Choose an audience before adding this target — generation stays blocked for it otherwise.
              </p>
              <Field label="Target note" value={manual.note} onChange={(note) => setManual({ ...manual, note })} multiline />
              <button
                type="button"
                className="ov3-button is-primary"
                disabled={busy || !manual.name.trim() || !manual.audienceType}
                onClick={() => void addManual()}
              >
                Add target to campaign
              </button>
            </section>
          ) : source === 'selected' ? (
            <SelectedTargetList
              selected={selected}
              readinessByKey={readinessByKey}
              busy={busy}
              onProfile={openProfile}
              onRemove={removeTarget}
            />
          ) : source === 'directory' ? (
            <TargetDirectoryBrowser
              selected={selected}
              busy={busy}
              applyCommands={applyCommands}
              onProfile={(locator) => void openProfile(locator)}
            />
          ) : source === 'saved' ? (
            <SavedAudiencesPanel
              audiences={savedAudiences.data ?? []}
              pending={savedAudiences.isLoading}
              error={savedAudiences.isError ? safeOutreachV3Error(savedAudiences.error) : null}
              busy={busy}
              onAddAll={(audience) => void addAudience(audience)}
            />
          ) : targetSearchPending ? (
            <div className="ov3-loading-list" aria-label="Searching targets"><span /><span /><span /></div>
          ) : visibleCandidates.length === 0 ? (
            <div className="ov3-empty-state">
              <UsersRound size={24} aria-hidden="true" />
              <strong>No matching targets</strong>
              <p>Broaden the criteria, use the Directory, or add a target manually.</p>
              <button type="button" className="ov3-button is-secondary" onClick={() => setSource('manual')}>
                Add manually
              </button>
            </div>
          ) : (
            <div className="ov3-card-list">
              {visibleCandidates.map((candidate) => {
                const selectedTarget = selectedByKey.get(candidate.targetKey);
                // An already-added candidate is the same person as a row in
                // the Selected tab, so it reads the same coverage-backed
                // verdict rather than the weaker candidate-only one.
                const readiness = selectedTarget
                  ? readinessByKey.get(candidate.targetKey) ?? candidateReadiness(candidate)
                  : candidateReadiness(candidate);
                const reasons = readiness.state === 'blocked' ? readinessReasons(readiness) : [];
                return (
                  <article
                    key={candidate.recommendationRef}
                    className={cx('ov3-target-card', selectedTarget && 'is-selected')}
                  >
                    <header>
                      <span className="ov3-avatar">{candidate.displayName.slice(0, 2).toUpperCase()}</span>
                      <div>
                        <strong>{candidate.displayName}</strong>
                        <p>{candidate.title || candidate.organization || 'Government-affairs target'}</p>
                      </div>
                      <StatusPill tone={candidate.roleStatus === 'current' ? 'success' : 'warning'}>
                        {sentence(candidate.roleStatus)}
                      </StatusPill>
                    </header>
                    {candidate.signals.length ? (
                      <div className="ov3-target-card__signals">
                        {candidate.signals.slice(0, 2).map((signal) => (
                          <span
                            key={signal.code}
                            className={cx('eng-pill', 'eng-pill--sm', signalPillTone(signal))}
                          >
                            {signal.label}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="ov3-target-card__why">Matches the current target criteria.</p>
                    )}
                    <div className="ov3-target-card__meta">
                      <span>{candidate.organization || candidate.jurisdiction.chamber || 'Directory'}</span>
                      {/* Readiness rides in the meta row here, not in the
                          header pill the Selected tab uses for it: an
                          unselected candidate's verdict is usually "unknown"
                          by construction, and promoting that to the card's
                          most prominent element on every search row would say
                          less than the role status it would displace. */}
                      <ReadinessCell readiness={readiness} />
                      <span>{Math.round(candidate.score * 100)}% match</span>
                    </div>
                    {reasons.length ? (
                      <p className="ov3-target-card__why">Blocking send: {reasons.join('; ')}.</p>
                    ) : null}
                    <footer>
                      <button type="button" className="ov3-button is-quiet" onClick={() => void openProfile(candidate.locator)}>
                        View profile
                      </button>
                      {!selectedTarget ? (
                        <button type="button" className="ov3-button is-quiet" onClick={() => void dismissCandidate(candidate)}>
                          Not relevant
                        </button>
                      ) : null}
                      <span />
                      {selectedTarget ? (
                        <>
                          <button type="button" className="ov3-button is-secondary" disabled>
                            <Check size={15} aria-hidden="true" /> Added
                          </button>
                          <button type="button" className="ov3-button is-quiet" disabled={busy} onClick={() => void removeTarget(candidate.targetKey)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ov3-button is-primary" disabled={busy} onClick={() => void addCandidate(candidate)}>
                          Add target
                        </button>
                      )}
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <aside className="ov3-inspector ov3-target-inspector">
          <header>
            <span className="ov3-eyebrow">Target profile</span>
            {profileStatus ? (
              <StatusPill tone={profileStatus === 'current' ? 'success' : 'warning'}>
                {sentence(profileStatus)}
              </StatusPill>
            ) : null}
          </header>
          {targetProfilePending ? (
            <div className="ov3-centered"><Loader2 className="ov3-spin" /></div>
          ) : profileTarget && profileData && profile ? (
            <>
              <div className="ov3-inspector__identity">
                <span className="ov3-avatar is-large">{profileTarget.displayName.slice(0, 2).toUpperCase()}</span>
                <div>
                  <h3>{profileTarget.displayName}</h3>
                  <p>{profileData.role.title || profileData.role.organization || 'Target'}</p>
                </div>
              </div>
              <div className="ov3-profile-status-row">
                <StatusPill tone={profileData.role.status === 'current' ? 'success' : 'warning'}>
                  Role {profileData.role.status}
                </StatusPill>
                <StatusPill tone={profileData.contact.emailStatus === 'available' ? 'info' : 'warning'}>
                  Email {profileData.contact.emailStatus}
                </StatusPill>
                {activeSelected ? <StatusPill tone="success">Selected</StatusPill> : null}
              </div>

              {snapshotChanged ? (
                <div className="ov3-recovery is-warning">
                  <History size={17} aria-hidden="true" />
                  <div>
                    <strong>The selected target snapshot changed</strong>
                    <p>{profile.selectionSnapshot.changedFields.join(', ') || 'One or more profile fields changed.'}</p>
                  </div>
                </div>
              ) : null}

              <dl className="ov3-detail-list">
                <div><dt>Office</dt><dd>{profileData.role.organization || 'Not listed'}</dd></div>
                <div><dt>Email</dt><dd>{profileData.contact.email || 'Not available'}</dd></div>
                <div><dt>Phone</dt><dd>{profileData.contact.phone || 'Not available'}</dd></div>
                <div><dt>Committees</dt><dd>{profileData.jurisdiction.committees.join(', ') || 'Not listed'}</dd></div>
                <div><dt>Issue areas</dt><dd>{profileData.jurisdiction.issueAreas.join(', ') || 'Not listed'}</dd></div>
                <div><dt>Source</dt><dd>{sentence(profileData.dataQuality.sourceSystem)}</dd></div>
                <div><dt>Verified</dt><dd>{formatDate(profileData.dataQuality.lastVerifiedAt)}</dd></div>
              </dl>

              {profileData.warnings.length ? (
                <div className="ov3-target-warning-list">
                  {profileData.warnings.map((warning) => (
                    <div key={warning.code} className="ov3-recovery is-warning">
                      <CircleAlert size={16} aria-hidden="true" />
                      <div><strong>{sentence(warning.code)}</strong><p>{warning.message}</p></div>
                    </div>
                  ))}
                </div>
              ) : null}

              <section className="ov3-profile-facts">
                <span className="ov3-section-label">Personalization facts</span>
                {profileData.personalizationFacts.length ? (
                  profileData.personalizationFacts.map((fact) => (
                    <article key={fact.code}>
                      <div>
                        <strong>{fact.label}</strong>
                        <p>{Array.isArray(fact.value) ? fact.value.join(', ') : fact.value || 'Not available'}</p>
                      </div>
                      <StatusPill tone={fact.usableForPersonalization ? 'success' : 'warning'}>
                        {fact.usableForPersonalization ? 'Usable' : sentence(fact.status)}
                      </StatusPill>
                    </article>
                  ))
                ) : (
                  <p className="ov3-muted-copy">No approved personalization facts are available.</p>
                )}
              </section>

              <ProfileSection label="Known interests" section={profileData.positioning.knownInterests} />
              <ProfileSection label="District and state" section={profileData.governmentNexus.districtState} />

              <section className="ov3-relationship-panel">
                <div className="ov3-relationship-panel__header">
                  <div>
                    <span className="ov3-section-label">Relationship intelligence</span>
                    <p>
                      {sponsorClientId
                        ? 'Client-scoped meeting, email-envelope, and open-task metadata.'
                        : 'Choose one client sponsor to inspect client-scoped relationships.'}
                    </p>
                  </div>
                  {relationships.isPending ? <Loader2 className="ov3-spin" size={17} /> : null}
                </div>
                {relationship ? (
                  <>
                    <div className="ov3-relationship-metrics">
                      <span><strong>{relationship.data.interactionCount}</strong>Interactions</span>
                      <span><strong>{relationship.data.meetingCount}</strong>Meetings</span>
                      <span><strong>{relationship.data.emailCount}</strong>Emails</span>
                    </div>
                    <StatusPill tone={relationship.data.status === 'none' ? 'neutral' : 'success'}>
                      {sentence(relationship.data.status)} relationship
                    </StatusPill>
                    {relationship.data.lastInteractionAt ? (
                      <p className="ov3-muted-copy">
                        Last interaction {formatDate(relationship.data.lastInteractionAt)}
                      </p>
                    ) : null}
                    {relationship.data.recentInteractions.slice(0, 3).map((interaction) => (
                      <div key={`${interaction.type}-${interaction.occurredAt}-${interaction.label}`} className="ov3-relationship-event">
                        {interaction.type === 'meeting' ? <CalendarClock size={15} /> : <Mail size={15} />}
                        <div><strong>{interaction.label}</strong><span>{formatDate(interaction.occurredAt)}</span></div>
                      </div>
                    ))}
                    {relationship.data.openCommitments.slice(0, 3).map((commitment) => (
                      <div key={commitment.id} className="ov3-relationship-event">
                        <BadgeCheck size={15} />
                        <div><strong>{commitment.title}</strong><span>{commitment.dueDate || commitment.status}</span></div>
                      </div>
                    ))}
                  </>
                ) : relationships.isError ? (
                  <p className="ov3-muted-copy">{safeOutreachV3Error(relationships.error)}</p>
                ) : (
                  <p className="ov3-muted-copy">
                    {sponsorClientId
                      ? 'Relationship metadata loads when the profile opens.'
                      : profileData.relationshipMetadata.lastContactAt
                        ? `Last known contact ${formatDate(profileData.relationshipMetadata.lastContactAt)}.`
                        : 'No client-scoped relationship analysis is available.'}
                  </p>
                )}
              </section>

              <div className="ov3-recovery is-info">
                <ShieldCheck size={17} aria-hidden="true" />
                <div>
                  <strong>Profile is source-backed and bounded</strong>
                  <p>
                    Private note and email bodies remain excluded until governed context review.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="ov3-empty-state is-compact">
              <UserRound size={23} />
              <strong>Inspect a target before adding it</strong>
              <p>Open a profile to review role, contactability, freshness, and relationship health.</p>
            </div>
          )}

          <section className="ov3-coverage-card">
            <span className="ov3-section-label">Audience coverage</span>
            {coveragePending ? (
              <Loader2 className="ov3-spin" size={18} />
            ) : (
              <>
                <strong>{selected.length} selected</strong>
                {/* "send-ready", the same words the per-target rows use, so
                    the two numbers read as the same measurement. This said
                    "email-ready" while counting a four-condition predicate. */}
                <p>{sendReadyCount} send-ready</p>
                <div className="ov3-meter">
                  <span
                    style={{
                      width: `${Math.min(
                        100,
                        (sendReadyCount / Math.max(selected.length, 1)) * 100,
                      )}%`,
                    }}
                  />
                </div>
                {notSendReadyCount > 0 ? (
                  <p className="ov3-muted-copy">
                    {notSendReadyCount} not send-ready
                    {coverageBlockers.length ? ` · ${coverageBlockers.join(' · ')}` : ''}
                  </p>
                ) : null}
                {coverage?.snapshotRevalidation.some((entry) => entry.status === 'changed') ? (
                  <p className="ov3-muted-copy">One or more selected profile snapshots changed.</p>
                ) : null}
              </>
            )}
          </section>
        </aside>
      </div>

      <ErrorNotice message={error ?? targetSearchError} />
      <footer className="ov3-panel-footer">
        <span>
          {selected.length} selected · {highConfidence.length} high-confidence available · selection
          stays on this screen until you continue
        </span>
        <div className="ov3-panel-footer__actions">
          <button
            type="button"
            className="ov3-button is-secondary"
            disabled={busy}
            onClick={() => void applyCommands([criteriaCommand()]).catch((caught) => setError(safeOutreachV3Error(caught)))}
          >
            Save criteria
          </button>
        </div>
      </footer>
    </section>
  );
}

function SelectedTargetList({
  selected,
  readinessByKey,
  busy,
  onProfile,
  onRemove,
}: {
  selected: OutreachV3ResolvedTargetRef[];
  /** The same verdicts the Audience coverage meter counts. */
  readinessByKey: Map<string, SendReadiness>;
  busy: boolean;
  onProfile: (locator: OutreachV3TargetLocator) => Promise<void>;
  onRemove: (targetKey: string) => Promise<void>;
}) {
  if (!selected.length) {
    return (
      <div className="ov3-empty-state">
        <ContactRound size={24} />
        <strong>No selected targets</strong>
        <p>Return to Recommended or Directory and add at least one target.</p>
      </div>
    );
  }
  return (
    <div className="ov3-card-list">
      {selected.map((target) => {
        const readiness = readinessByKey.get(target.targetKey) ?? UNKNOWN;
        const reasons = readinessReasons(readiness);
        return (
          <article key={target.targetKey} className="ov3-target-card is-selected">
            <header>
              <span className="ov3-avatar">{target.displayName.slice(0, 2).toUpperCase()}</span>
              <div><strong>{target.displayName}</strong><p>{target.title || target.organization || 'Target'}</p></div>
              <StatusPill tone={readiness.state === 'ready' ? 'success' : 'warning'}>
                {SEND_READINESS_LABELS[readiness.state]}
              </StatusPill>
            </header>
            <div className="ov3-target-card__meta">
              <span>{target.sourceSnapshot?.system ? sentence(target.sourceSnapshot.system) : sentence(target.locator.source)}</span>
              {/* Role stays visible in its own right — it is one of the four
                  send conditions, not a substitute for the verdict above. */}
              <span>Role {target.roleStatus}</span>
              <span>Verified {formatDate(target.sourceSnapshot?.lastVerifiedAt)}</span>
            </div>
            {reasons.length ? (
              <p className="ov3-target-card__why">
                {readiness.state === 'blocked' ? 'Blocking send' : 'Not counted as send-ready'}:{' '}
                {reasons.join('; ')}.
              </p>
            ) : null}
            <footer>
              <button type="button" className="ov3-button is-quiet" onClick={() => void onProfile(target.locator)}>
                View profile <ChevronRight size={14} />
              </button>
              <span />
              <button type="button" className="ov3-button is-secondary" disabled>
                <Check size={15} /> Added
              </button>
              <button type="button" className="ov3-button is-quiet" disabled={busy} onClick={() => void onRemove(target.targetKey)}>
                <X size={15} /> Remove
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
