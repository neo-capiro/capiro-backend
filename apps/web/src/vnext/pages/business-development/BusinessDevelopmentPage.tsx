import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { UseMutationResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hasAtLeast } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { CapiroButton, CapiroIconButton } from '../../components/actions/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { formatDateShort } from '../../lib/labels.js';
import { PortfolioIndexPage } from '../portfolio/PortfolioIndexPage.js';
import { DiscoverPanel } from './BizDevDiscover.js';
import { DossierDrawer } from './BizDevDossier.js';
import { BizDevBrief } from './BizDevBrief.js';
import { openVNextMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';
import {
  applyBizDevRoute,
  BIZDEV_CONFLICT_FILTERS,
  BIZDEV_STAGES,
  BIZDEV_STAGE_LABELS,
  BIZDEV_STATUSES,
  BIZDEV_STATUS_LABELS,
  BIZDEV_VIEW_LABELS,
  bizDevListQuery,
  hasBizDevFilters,
  isBizDevOverdue,
  resolveBizDevRoute,
  type BizDevStage,
  type BizDevView,
} from './bizdev-routing.js';
import { BizDevWatchlist } from './BizDevWatchlist.js';
import {
  addBizDevNote,
  bizdevErrorMessage,
  bizdevKeys,
  convertBizDevProspect,
  createBizDevBrief,
  createBizDevProspect,
  dismissBizDevProspect,
  getBizDevCurrentBrief,
  getBizDevDuplicateHints,
  getBizDevHistory,
  getBizDevMemberOptions,
  getBizDevPreferences,
  getBizDevProspect,
  listBizDevProspects,
  newBizDevIdempotencyKey,
  previewBizDevDuplicateHints,
  restoreBizDevProspect,
  saveBizDevPreferences,
  searchBizDevCanonicalOrganizations,
  searchBizDevClients,
  updateBizDevConflict,
  updateBizDevProspect,
  resolveBizDevIdentity,
  activateBizDevWatch,
  BIZDEV_SOURCE_HEALTH_LABELS,
  bizdevWatchKeys,
  dismissBizDevAlert,
  getBizDevProspectAlerts,
  getBizDevProspectWatch,
  markBizDevAlertRead,
  updateBizDevWatch,
  type BizDevActivateWatchInput,
  type BizDevProspectAlert,
  type BizDevUpdateWatchInput,
  type BizDevWatchSource,
  type BizDevWatchSourceHealth,
  type BizDevMemberOption,
  type BizDevProspect,
  type BizDevDuplicateHint,
} from './bizdev-api.js';
import './business-development.css';

/* ── small shared bits ──────────────────────────────────────────────── */

function memberName(m: BizDevMemberOption | undefined): string {
  if (!m) return '';
  const name = [m.firstName, m.lastName].filter(Boolean).join(' ');
  return name || m.email || '';
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '·'
  );
}

/** Polite live region for mutation outcomes (screen readers hear saves). */
function StatusNote({ text, warn }: { text: string; warn?: boolean }) {
  return (
    <p
      role="status"
      className={`capiro-bizdev__statusnote${warn ? ' capiro-bizdev__statusnote--warn' : ''}`}
    >
      {text}
    </p>
  );
}

/* ── Phase 4: tabs + Draft with Meri launch ──────────────────────────── */

/** Detail-drawer tabs. Evidence/Brief render only when their flag is on. */
type ProspectTab = 'overview' | 'evidence' | 'brief';

const PROSPECT_TAB_LABELS: Record<ProspectTab, string> = {
  overview: 'Overview',
  evidence: 'Evidence',
  brief: 'Brief',
};

/**
 * The bounded Draft-with-Meri prompt. Deliberately carries NO firm, prospect,
 * provider or scope facts: the conversation's server-resolved prospect scope
 * and its tools are the only authority for who/what/where. It asks for the
 * exact five-section grounded brief, evidence inspection, uncertainty and
 * citation preservation, and forbids outreach unless explicitly asked.
 */
export const BIZDEV_DRAFT_WITH_MERI_PROMPT =
  'Prepare or update the grounded opportunity brief for the active prospect. ' +
  'Inspect only the authorized evidence available to you and keep exactly these five sections: ' +
  'Company and firm implication, Verified evidence, Judgment, Practical action, and Missing information. ' +
  'Preserve uncertainty and keep every claim tied to its citation. ' +
  'Do not draft or send any outreach unless I explicitly ask for it.';

/**
 * One-click Draft with Meri: if the prospect has no saved brief yet, first
 * await creation of the deterministic initial brief (so the approval-gated
 * Meri save tool has a current version/citation set), then open the existing
 * docked Meri chat with a fresh prospect-scoped session and the bounded
 * prompt. A create failure must NOT launch Meri — surface the error instead.
 */
async function draftBriefWithMeri(
  api: ReturnType<typeof useApi>,
  queryClient: ReturnType<typeof useQueryClient>,
  tenantId: string,
  prospect: BizDevProspect,
  toast: ReturnType<typeof useCapiroToast>,
): Promise<void> {
  try {
    const current = await getBizDevCurrentBrief(api, prospect.id);
    if (!current.brief) {
      await createBizDevBrief(api, prospect.id, {
        idempotencyKey: newBizDevIdempotencyKey('create'),
      });
      void queryClient.invalidateQueries({
        queryKey: bizdevKeys.brief(tenantId, prospect.id),
      });
      void queryClient.invalidateQueries({
        queryKey: bizdevKeys.briefVersions(tenantId, prospect.id),
      });
    }
  } catch (error) {
    // No brief existed and the deterministic initial brief could not be
    // created: launching Meri would give the save tool nothing to cite.
    toast.error(bizdevErrorMessage(error));
    return;
  }
  openVNextMeriWorkspaceWindow(window, window.location.origin, {
    prompt: BIZDEV_DRAFT_WITH_MERI_PROMPT,
    prospectId: prospect.id,
  });
}

/** Keyboard-native tab strip; hidden panels stay mounted-free (no queries). */
function ProspectTabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: ProspectTab[];
  active: ProspectTab;
  onSelect: (tab: ProspectTab) => void;
}) {
  return (
    <div className="capiro-bizdev__tabs" role="tablist" aria-label="Prospect detail">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`bizdev-tab-${tab}`}
          aria-selected={active === tab}
          aria-controls={`bizdev-tabpanel-${tab}`}
          className={`capiro-bizdev__tab${active === tab ? ' is-active' : ''}`}
          onClick={() => onSelect(tab)}
        >
          {PROSPECT_TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}

/**
 * Reusable identity review/correction controls (Phase 1 canonical search +
 * resolveBizDevIdentity, reused for already-resolved prospects when the
 * dossier feature is on). Duplicate outcome = review/open-existing, never a
 * merge claim.
 */
function IdentityReviewControls({
  identityState,
}: {
  identityState: {
    orgQuery: string;
    setOrgQuery: (v: string) => void;
    orgResults: Array<{ id: string; canonicalName: string; identityScope?: string }> | null;
    setOrgResults: (v: Array<{ id: string; canonicalName: string; identityScope?: string }> | null) => void;
    orgSearch: import('@tanstack/react-query').UseMutationResult<
      import('./bizdev-api.js').BizDevCanonicalOrganization[],
      Error,
      void,
      unknown
    >;
    resolveIdentity: import('@tanstack/react-query').UseMutationResult<
      import('./bizdev-api.js').BizDevResolveIdentityResult,
      Error,
      string,
      unknown
    >;
    duplicateNotice: { prospectId: string; displayName: string; status: string } | null;
    hints: import('./bizdev-api.js').BizDevDuplicateHint[];
  };
}) {
  return (
    <div className="capiro-bizdev__actions">
      <input
        className="capiro-bizdev__input capiro-bizdev__input--grow"
        aria-label="Search confirmed organizations"
        value={identityState.orgQuery}
        onChange={(e) => identityState.setOrgQuery(e.target.value)}
        placeholder="Search confirmed organizations by name"
        maxLength={200}
      />
      <CapiroButton
        size="compact"
        loading={identityState.orgSearch.isPending}
        disabled={!identityState.orgQuery.trim()}
        onClick={() => identityState.orgSearch.mutate()}
      >
        Search
      </CapiroButton>
      {identityState.orgResults ? (
        identityState.orgResults.length === 0 ? (
          <StatusNote text="No confirmed organizations matched." />
        ) : (
          <ul className="capiro-bizdev__picker-list">
            {identityState.orgResults.map((org) => (
              <li key={org.id}>
                <div className="capiro-bizdev__picker-row">
                  <span className="capiro-bizdev__picker-name">
                    {org.canonicalName}
                    {org.identityScope ? (
                      <span className="capiro-bizdev__picker-meta">
                        {' '}
                        ·{' '}
                        {org.identityScope === 'tenant_private'
                          ? 'private to your firm'
                          : 'public shared record'}
                      </span>
                    ) : null}
                  </span>
                  <CapiroButton
                    size="compact"
                    variant="primary"
                    loading={identityState.resolveIdentity.isPending}
                    onClick={() => identityState.resolveIdentity.mutate(org.id)}
                  >
                    Confirm identity
                  </CapiroButton>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/* ── filters toolbar ────────────────────────────────────────────────── */

function BizDevFilters({ members }: { members: BizDevMemberOption[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolveBizDevRoute(searchParams);
  const setRoute = (patch: Parameters<typeof applyBizDevRoute>[1]) =>
    setSearchParams(applyBizDevRoute(searchParams, patch));

  return (
    <div className="capiro-bizdev__filters" aria-label="Pipeline filters">
      <label className="capiro-bizdev__label capiro-bizdev__sr-only" htmlFor="bizdev-search">
        Search prospects
      </label>
      <input
        id="bizdev-search"
        className="capiro-bizdev__search"
        type="search"
        value={route.q}
        placeholder="Search by company name"
        onChange={(e) =>
          setSearchParams(applyBizDevRoute(searchParams, { q: e.target.value }), { replace: true })
        }
      />
      <select
        className="capiro-bizdev__select"
        aria-label="Filter by stage"
        value={route.stage}
        onChange={(e) => setRoute({ stage: e.target.value as BizDevStage | '' })}
      >
        <option value="">All stages</option>
        {BIZDEV_STAGES.map((s) => (
          <option key={s} value={s}>
            {BIZDEV_STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      <select
        className="capiro-bizdev__select"
        aria-label="Filter by owner"
        value={route.ownerId}
        onChange={(e) => setRoute({ ownerId: e.target.value })}
      >
        <option value="">All owners</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {memberName(m)}
          </option>
        ))}
      </select>
      <select
        className="capiro-bizdev__select"
        aria-label="Filter by status"
        value={route.status}
        onChange={(e) => setRoute({ status: e.target.value as (typeof BIZDEV_STATUSES)[number] })}
      >
        {BIZDEV_STATUSES.map((status) => (
          <option key={status} value={status}>
            {BIZDEV_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
      <select
        className="capiro-bizdev__select"
        aria-label="Filter by conflict or exclusion"
        value={route.conflict}
        onChange={(e) => setRoute({ conflict: e.target.value as '' | 'excl' | 'none' })}
      >
        <option value="">Any conflict state</option>
        <option value={BIZDEV_CONFLICT_FILTERS[1]}>Excluded only</option>
        <option value={BIZDEV_CONFLICT_FILTERS[2]}>Not excluded</option>
      </select>
      <select
        className="capiro-bizdev__select"
        aria-label="Filter by linked client"
        value={route.linkedClient}
        onChange={(e) => setRoute({ linkedClient: e.target.value as '' | 'yes' | 'no' })}
      >
        <option value="">Any client link</option>
        <option value="yes">Already a client</option>
        <option value="no">Not a client yet</option>
      </select>
    </div>
  );
}

/* ── create modal ───────────────────────────────────────────────────── */

function CreateProspectModal({
  members,
  onClose,
  onCreated,
  onOpenExisting,
}: {
  members: BizDevMemberOption[];
  onClose: () => void;
  onCreated: (prospect: BizDevProspect) => void;
  onOpenExisting: (id: string) => void;
}) {
  const api = useApi();
  const toast = useCapiroToast();
  const [displayName, setDisplayName] = useState('');
  const [domain, setDomain] = useState('');
  const [website, setWebsite] = useState('');
  const [description, setDescription] = useState('');
  const [serviceHypothesis, setServiceHypothesis] = useState('');
  const [geography, setGeography] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [stage, setStage] = useState<BizDevStage>('researching');
  const [canonicalEntityId, setCanonicalEntityId] = useState<string | null>(null);
  const [orgQuery, setOrgQuery] = useState('');
  const [orgResults, setOrgResults] = useState<Array<{
    id: string;
    canonicalName: string;
    identityScope: string;
  }> | null>(null);
  const [duplicateHints, setDuplicateHints] = useState<BizDevDuplicateHint[] | null>(null);
  const [duplicatesReviewed, setDuplicatesReviewed] = useState(false);

  const resetDuplicateReview = () => {
    setDuplicateHints(null);
    setDuplicatesReviewed(false);
  };

  const orgSearch = useMutation({
    mutationFn: () => searchBizDevCanonicalOrganizations(api, orgQuery),
    onSuccess: (results) => setOrgResults(results),
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const create = useMutation({
    mutationFn: () =>
      createBizDevProspect(api, {
        displayName: displayName.trim(),
        ...(canonicalEntityId ? { canonicalEntityId } : {}),
        ...(domain.trim() ? { domain: domain.trim() } : {}),
        ...(website.trim() ? { website: website.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(serviceHypothesis.trim() ? { serviceHypothesis: serviceHypothesis.trim() } : {}),
        ...(geography.trim() ? { geography: geography.trim() } : {}),
        ...(ownerUserId ? { ownerUserId } : {}),
        ...(stage !== 'researching' ? { stage } : {}),
      }),
    onSuccess: (prospect) => {
      // Confirmed duplicates may return or restore the existing prospect;
      // avoid claiming that a second record was created.
      toast.success(`Prospect “${prospect.displayName}” is ready`);
      onCreated(prospect);
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const previewDuplicates = useMutation({
    mutationFn: () =>
      previewBizDevDuplicateHints(api, {
        displayName: displayName.trim(),
        ...(domain.trim() ? { domain: domain.trim() } : {}),
        ...(website.trim() ? { website: website.trim() } : {}),
        ...(canonicalEntityId ? { canonicalEntityId } : {}),
      }),
    onSuccess: ({ hints }) => {
      setDuplicateHints(hints);
      setDuplicatesReviewed(true);
      if (hints.length === 0) create.mutate();
    },
    onError: (error) => toast.error(bizdevErrorMessage(error)),
  });

  const restoreHint = useMutation({
    mutationFn: (id: string) => restoreBizDevProspect(api, id),
    onSuccess: (prospect) => {
      toast.success('Existing prospect restored; its history was preserved');
      onOpenExisting(prospect.id);
    },
    onError: (error) => toast.error(bizdevErrorMessage(error)),
  });

  return (
    <CapiroModal open title="Add prospect" onClose={onClose} width={640}>
      <form
        className="capiro-bizdev__drawer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!displayName.trim()) return;
          if (duplicatesReviewed) create.mutate();
          else previewDuplicates.mutate();
        }}
      >
        <StatusNote
          warn={!canonicalEntityId}
          text={
            canonicalEntityId
              ? 'This prospect will be linked to a confirmed organization record.'
              : 'Without a confirmed organization, this stays a private, manually-entered prospect for your firm. It does not create or imply a shared organization record.'
          }
        />
        <div className="capiro-bizdev__field-grid">
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-name">
              Company name (required)
            </label>
            <input
              id="bizdev-new-name"
              className="capiro-bizdev__input"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                resetDuplicateReview();
              }}
              required
              maxLength={200}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-domain">
              Domain (optional)
            </label>
            <input
              id="bizdev-new-domain"
              className="capiro-bizdev__input"
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                resetDuplicateReview();
              }}
              maxLength={200}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-website">
              Website (optional)
            </label>
            <input
              id="bizdev-new-website"
              className="capiro-bizdev__input"
              value={website}
              onChange={(e) => {
                setWebsite(e.target.value);
                resetDuplicateReview();
              }}
              maxLength={500}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-geography">
              Geography (optional)
            </label>
            <input
              id="bizdev-new-geography"
              className="capiro-bizdev__input"
              value={geography}
              onChange={(e) => setGeography(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-owner">
              Owner (optional)
            </label>
            <select
              id="bizdev-new-owner"
              className="capiro-bizdev__select"
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
            >
              <option value="">Me</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {memberName(m)}
                </option>
              ))}
            </select>
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-stage">
              Stage
            </label>
            <select
              id="bizdev-new-stage"
              className="capiro-bizdev__select"
              value={stage}
              onChange={(event) => setStage(event.target.value as BizDevStage)}
            >
              {BIZDEV_STAGES.map((value) => (
                <option key={value} value={value}>
                  {BIZDEV_STAGE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-hypothesis">
              Service hypothesis (optional)
            </label>
            <input
              id="bizdev-new-hypothesis"
              className="capiro-bizdev__input"
              value={serviceHypothesis}
              onChange={(e) => setServiceHypothesis(e.target.value)}
              maxLength={4000}
            />
          </div>
          <div className="capiro-bizdev__field capiro-bizdev__field--full">
            <label className="capiro-bizdev__label" htmlFor="bizdev-new-description">
              Description (optional)
            </label>
            <textarea
              id="bizdev-new-description"
              className="capiro-bizdev__textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4000}
            />
          </div>
        </div>

        <div className="capiro-bizdev__field">
          <label className="capiro-bizdev__label" htmlFor="bizdev-org-search">
            Confirmed organization (optional — skip to keep it manual)
          </label>
          <div className="capiro-bizdev__actions">
            <input
              id="bizdev-org-search"
              className="capiro-bizdev__input"
              style={{ flex: '1 1 220px' }}
              value={orgQuery}
              onChange={(e) => setOrgQuery(e.target.value)}
              placeholder="Search confirmed organizations by name"
              maxLength={200}
            />
            <CapiroButton
              size="compact"
              loading={orgSearch.isPending}
              disabled={!orgQuery.trim()}
              onClick={() => orgSearch.mutate()}
            >
              Search
            </CapiroButton>
          </div>
          {canonicalEntityId ? (
            <StatusNote
              text={`Confirmed: ${orgResults?.find((o) => o.id === canonicalEntityId)?.canonicalName ?? 'selected organization'}. Creating a duplicate confirmed prospect re-opens the existing one instead of making a second record.`}
            />
          ) : null}
          {orgResults ? (
            orgResults.length === 0 ? (
              <StatusNote text="No confirmed organizations matched. You can still save this as a manual prospect." />
            ) : (
              <ul className="capiro-bizdev__picker-list">
                {orgResults.map((org) => (
                  <li key={org.id}>
                    <div className="capiro-bizdev__picker-row">
                      <span className="capiro-bizdev__picker-name">{org.canonicalName}</span>
                      <CapiroButton
                        size="compact"
                        variant={canonicalEntityId === org.id ? 'primary' : 'secondary'}
                        onClick={() => {
                          setCanonicalEntityId(org.id);
                          setDisplayName((d) => d.trim() || org.canonicalName);
                          resetDuplicateReview();
                        }}
                      >
                        {canonicalEntityId === org.id ? 'Selected' : 'Use'}
                      </CapiroButton>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>

        {duplicateHints && duplicateHints.length > 0 ? (
          <div className="capiro-bizdev__field" role="status">
            <StatusNote
              warn
              text="Review these same-firm prospects before saving. Open an active record or restore a dismissed one to keep its history. Manual unresolved records may still be saved separately when they are genuinely different."
            />
            <ul className="capiro-bizdev__picker-list">
              {duplicateHints.map((hint) => (
                <li key={hint.id}>
                  <div className="capiro-bizdev__picker-row">
                    <span className="capiro-bizdev__picker-name">
                      {hint.displayName} · {hint.status === 'dismissed' ? 'Dismissed' : 'Active'}
                    </span>
                    <CapiroButton
                      size="compact"
                      loading={restoreHint.isPending && hint.status === 'dismissed'}
                      onClick={() => {
                        if (hint.status === 'dismissed') restoreHint.mutate(hint.id);
                        else onOpenExisting(hint.id);
                      }}
                    >
                      {hint.status === 'dismissed' ? 'Restore and open' : 'Open existing'}
                    </CapiroButton>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="capiro-bizdev__actions" style={{ justifyContent: 'flex-end' }}>
          <CapiroButton size="compact" onClick={onClose}>
            Cancel
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            type="submit"
            loading={create.isPending || previewDuplicates.isPending}
            disabled={!displayName.trim()}
          >
            {duplicateHints && duplicateHints.length > 0 && !canonicalEntityId
              ? 'Save separate manual prospect'
              : duplicatesReviewed
                ? 'Continue with reviewed prospect'
                : 'Review duplicates and add'}
          </CapiroButton>
        </div>
      </form>
    </CapiroModal>
  );
}

/* ── detail drawer ──────────────────────────────────────────────────── */

function ProspectDrawer({
  tenantId,
  prospectId,
  members,
  isAdmin,
  dossierEnabled,
  briefEnabled,
  meriProspectToolsEnabled,
  watchAlertsEnabled,
  onClose,
}: {
  tenantId: string;
  prospectId: string;
  members: BizDevMemberOption[];
  isAdmin: boolean;
  dossierEnabled: boolean;
  briefEnabled: boolean;
  meriProspectToolsEnabled: boolean;
  watchAlertsEnabled: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const detail = useQuery({
    queryKey: bizdevKeys.detail(tenantId, prospectId),
    queryFn: () => getBizDevProspect(api, prospectId),
    networkMode: 'always',
  });
  const history = useQuery({
    queryKey: bizdevKeys.history(tenantId, prospectId),
    queryFn: () => getBizDevHistory(api, prospectId),
  });
  const hints = useQuery({
    queryKey: bizdevKeys.duplicateHints(tenantId, prospectId),
    queryFn: () => getBizDevDuplicateHints(api, prospectId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: bizdevKeys.all(tenantId) });
  };

  const close = () => {
    setSearchParams(applyBizDevRoute(searchParams, { prospectId: '' }), { replace: true });
    onClose();
  };

  const [noteBody, setNoteBody] = useState('');
  const addNote = useMutation({
    mutationFn: () => addBizDevNote(api, prospectId, noteBody.trim()),
    onSuccess: (entries) => {
      setNoteBody('');
      queryClient.setQueryData(bizdevKeys.history(tenantId, prospectId), entries);
      invalidate();
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const dismiss = useMutation({
    mutationFn: () => dismissBizDevProspect(api, prospectId),
    onSuccess: () => {
      toast.success('Prospect dismissed. Its history is preserved.');
      invalidate();
      close();
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: () => restoreBizDevProspect(api, prospectId),
    onSuccess: () => {
      toast.success('Prospect restored');
      invalidate();
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [convertMode, setConvertMode] = useState<'create' | 'link'>('create');
  const [clientQuery, setClientQuery] = useState('');
  const [clientResults, setClientResults] = useState<Array<{ id: string; name: string }> | null>(
    null,
  );
  const [selectedClientId, setSelectedClientId] = useState('');

  const clientSearch = useMutation({
    mutationFn: () => searchBizDevClients(api, clientQuery),
    onSuccess: (results) => setClientResults(results),
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const convert = useMutation({
    mutationFn: () =>
      convertBizDevProspect(api, prospectId, {
        ...(convertMode === 'link' && selectedClientId
          ? { existingClientId: selectedClientId }
          : {}),
      }),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result.created
          ? `Client “${result.client.name}” created and linked`
          : `Linked to existing client “${result.client.name}”`,
      );
      // Show/open the linked client; the prospect record and its history stay
      // intact and reachable from this pipeline.
      navigate(`/clients?clientId=${encodeURIComponent(result.client.id)}`);
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const [orgQuery, setOrgQuery] = useState('');
  const [orgResults, setOrgResults] = useState<Array<{ id: string; canonicalName: string }> | null>(
    null,
  );
  const orgSearch = useMutation({
    mutationFn: () => searchBizDevCanonicalOrganizations(api, orgQuery),
    onSuccess: (results) => setOrgResults(results),
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });
  const [duplicateNotice, setDuplicateNotice] = useState<{
    prospectId: string;
    displayName: string;
    status: string;
  } | null>(null);
  const resolveIdentity = useMutation({
    mutationFn: (canonicalEntityId: string) =>
      resolveBizDevIdentity(api, prospectId, canonicalEntityId),
    onSuccess: (result) => {
      if (result.outcome === 'duplicate') {
        setDuplicateNotice(result.duplicate);
        toast.error(
          'Another prospect of your firm already holds that organization. Open it instead — histories are never merged.',
        );
      } else {
        toast.success('Organization identity confirmed');
        setOrgResults(null);
        invalidate();
      }
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const [conflictExcluded, setConflictExcluded] = useState<boolean | null>(null);
  const [conflictReason, setConflictReason] = useState<string | null>(null);
  const saveConflict = useMutation({
    mutationFn: (input: { conflictExcluded: boolean; conflictReason?: string }) =>
      updateBizDevConflict(api, prospectId, input),
    onSuccess: () => {
      toast.success('Conflict state updated');
      setConflictReason(null);
      setConflictExcluded(null);
      invalidate();
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  // Phase 4 tabs: Overview always; Evidence only with the dossier flag;
  // Brief only with the brief flag. Unmounted tabs run no queries.
  const availableTabs: ProspectTab[] = [
    'overview',
    ...(dossierEnabled ? (['evidence'] as const) : []),
    ...(briefEnabled ? (['brief'] as const) : []),
  ];
  const [activeTab, setActiveTab] = useState<ProspectTab>('overview');
  const activePanel = availableTabs.includes(activeTab) ? activeTab : 'overview';

  if (detail.isPending) {
    return (
      <CapiroDrawer open title="Prospect" onClose={close}>
        <div className="capiro-bizdev__drawer" aria-busy="true">
          <div className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall" />
        </div>
      </CapiroDrawer>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <CapiroDrawer open title="Prospect" onClose={close}>
        <CapiroErrorState
          title="This prospect is unavailable"
          description="It could not be loaded right now. Nothing about it was changed."
          onRetry={() =>
            void queryClient.resetQueries({
              queryKey: bizdevKeys.detail(tenantId, prospectId),
              exact: true,
            })
          }
          retryLabel="Retry"
        />
      </CapiroDrawer>
    );
  }
  const prospect = detail.data;

  // Wider drawer for the Brief tab: five editable sections + the source
  // inspector need more than the default; the Overview keeps 560 so its
  // existing layout is untouched. min() keeps small screens responsive.
  const drawerWidth = activePanel === 'brief' ? 1040 : 560;

  return (
    <CapiroDrawer
      open
      title={`Prospect — ${prospect.displayName}`}
      onClose={close}
      width={drawerWidth}
    >
      <ProspectTabBar
        tabs={availableTabs}
        active={activePanel}
        onSelect={(tab) => setActiveTab(tab)}
      />
      {activePanel === 'brief' ? (
        <div
          className="capiro-bizdev__drawer"
          style={{ gap: 24 }}
          role="tabpanel"
          id="bizdev-tabpanel-brief"
          aria-labelledby="bizdev-tab-brief"
        >
          <BizDevBrief
            api={api}
            tenantId={tenantId}
            prospect={prospect}
            meriEnabled={briefEnabled && meriProspectToolsEnabled}
            onDraftWithMeri={() =>
              void draftBriefWithMeri(api, queryClient, tenantId, prospect, toast)
            }
          />
        </div>
      ) : activePanel === 'evidence' ? (
        <div
          className="capiro-bizdev__drawer"
          style={{ gap: 24 }}
          role="tabpanel"
          id="bizdev-tabpanel-evidence"
          aria-labelledby="bizdev-tab-evidence"
        >
          {/* Evidence reuses the existing dossier surface for THIS prospect —
              no duplicated source-inspector logic; the drawer below is keyed
              to the same prospect id and stays visibly associated with it. */}
          <StatusNote
            text={`Evidence dossier for ${prospect.displayName}. Sources are the same authorized dossier records; nothing here is duplicated or editable outside the dossier surface.`}
          />
          <CapiroButton
            size="compact"
            onClick={() =>
              setSearchParams(applyBizDevRoute(searchParams, { dossierProspectId: prospect.id }))
            }
          >
            Open evidence dossier
          </CapiroButton>
        </div>
      ) : (
        <div role="tabpanel" id="bizdev-tabpanel-overview" aria-labelledby="bizdev-tab-overview">
          <ProspectDrawerBody
            key={prospect.id + prospect.updatedAt}
            tenantId={tenantId}
            prospect={prospect}
            members={members}
            isAdmin={isAdmin}
            dossierEnabled={dossierEnabled}
            watchAlertsEnabled={watchAlertsEnabled}
            meriProspectToolsEnabled={meriProspectToolsEnabled}
            api={api}
            invalidate={invalidate}
            history={history.data ?? []}
            noteState={{ noteBody, setNoteBody, addNote }}
            dismissState={{ confirmDismiss, setConfirmDismiss, dismiss, restore }}
            convertState={{
              convertMode,
              setConvertMode,
              clientQuery,
              setClientQuery,
              clientResults,
              setClientResults,
              clientSearch,
              selectedClientId,
              setSelectedClientId,
              convert,
            }}
            identityState={{
              orgQuery,
              setOrgQuery,
              orgResults,
              setOrgResults,
              orgSearch,
              resolveIdentity,
              duplicateNotice,
              hints: hints.data?.hints ?? [],
            }}
            conflictState={{
              conflictExcluded,
              setConflictExcluded,
              conflictReason,
              setConflictReason,
              saveConflict,
            }}
          />
        </div>
      )}
    </CapiroDrawer>
  );
}

/* ── drawer body (split for readability; one component per section) ──── */

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="capiro-bizdev__drawer" aria-label={title} style={{ gap: 10 }}>
      <h3 className="capiro-bizdev__section-title" style={{ fontSize: 15 }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function ProspectDrawerBody({
  tenantId,
  prospect,
  members,
  isAdmin,
  dossierEnabled,
  watchAlertsEnabled,
  meriProspectToolsEnabled,
  api,
  invalidate,
  history,
  noteState,
  dismissState,
  convertState,
  identityState,
  conflictState,
}: {
  tenantId: string;
  prospect: BizDevProspect;
  members: BizDevMemberOption[];
  isAdmin: boolean;
  dossierEnabled: boolean;
  watchAlertsEnabled: boolean;
  meriProspectToolsEnabled: boolean;
  api: ReturnType<typeof useApi>;
  invalidate: () => void;
  history: import('./bizdev-api.js').BizDevActivity[];
  noteState: {
    noteBody: string;
    setNoteBody: (v: string) => void;
    addNote: UseMutationResult<import('./bizdev-api.js').BizDevActivity[], Error, void, unknown>;
  };
  dismissState: {
    confirmDismiss: boolean;
    setConfirmDismiss: (v: boolean) => void;
    dismiss: UseMutationResult<BizDevProspect, Error, void, unknown>;
    restore: UseMutationResult<BizDevProspect, Error, void, unknown>;
  };
  convertState: {
    convertMode: 'create' | 'link';
    setConvertMode: (v: 'create' | 'link') => void;
    clientQuery: string;
    setClientQuery: (v: string) => void;
    clientResults: Array<{ id: string; name: string }> | null;
    setClientResults: (v: Array<{ id: string; name: string }> | null) => void;
    clientSearch: UseMutationResult<
      import('./bizdev-api.js').BizDevClientCandidate[],
      Error,
      void,
      unknown
    >;
    selectedClientId: string;
    setSelectedClientId: (v: string) => void;
    convert: UseMutationResult<import('./bizdev-api.js').BizDevConvertResult, Error, void, unknown>;
  };
  identityState: {
    orgQuery: string;
    setOrgQuery: (v: string) => void;
    orgResults: Array<{ id: string; canonicalName: string }> | null;
    setOrgResults: (v: Array<{ id: string; canonicalName: string }> | null) => void;
    orgSearch: UseMutationResult<
      import('./bizdev-api.js').BizDevCanonicalOrganization[],
      Error,
      void,
      unknown
    >;
    resolveIdentity: UseMutationResult<
      import('./bizdev-api.js').BizDevResolveIdentityResult,
      Error,
      string,
      unknown
    >;
    duplicateNotice: { prospectId: string; displayName: string; status: string } | null;
    hints: import('./bizdev-api.js').BizDevDuplicateHint[];
  };
  conflictState: {
    conflictExcluded: boolean | null;
    setConflictExcluded: (v: boolean | null) => void;
    conflictReason: string | null;
    setConflictReason: (v: string | null) => void;
    saveConflict: UseMutationResult<
      BizDevProspect,
      Error,
      { conflictExcluded: boolean; conflictReason?: string },
      unknown
    >;
  };
}) {
  const toast = useCapiroToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // Conversion pending guard — see the button below.
  const [convertClicked, setConvertClicked] = useState(false);
  useEffect(() => {
    if (!convertState.convert.isPending) setConvertClicked(false);
  }, [convertState.convert.isPending]);

  // edit form state (local; Save PATCHes the diff)
  const [displayName, setDisplayName] = useState(prospect.displayName);
  const [domain, setDomain] = useState(prospect.domain ?? '');
  const [website, setWebsite] = useState(prospect.website ?? '');
  const [description, setDescription] = useState(prospect.description ?? '');
  const [serviceHypothesis, setServiceHypothesis] = useState(prospect.serviceHypothesis ?? '');
  const [geography, setGeography] = useState(prospect.geography ?? '');
  const [ownerUserId, setOwnerUserId] = useState(prospect.ownerUserId ?? '');
  const [stage, setStage] = useState<BizDevStage>(prospect.stage);
  const [nextAction, setNextAction] = useState(prospect.nextAction ?? '');
  const [nextActionDueAt, setNextActionDueAt] = useState(
    prospect.nextActionDueAt ? prospect.nextActionDueAt.slice(0, 10) : '',
  );

  const save = useMutation({
    mutationFn: () =>
      updateBizDevProspect(api, prospect.id, {
        ...(displayName.trim() !== prospect.displayName ? { displayName: displayName.trim() } : {}),
        ...(domain !== (prospect.domain ?? '') ? { domain } : {}),
        ...(website !== (prospect.website ?? '') ? { website } : {}),
        ...(description !== (prospect.description ?? '') ? { description } : {}),
        ...(serviceHypothesis !== (prospect.serviceHypothesis ?? '') ? { serviceHypothesis } : {}),
        ...(geography !== (prospect.geography ?? '') ? { geography } : {}),
        ...(ownerUserId !== (prospect.ownerUserId ?? '')
          ? { ownerUserId: ownerUserId || null }
          : {}),
        ...(stage !== prospect.stage ? { stage } : {}),
        ...(nextAction !== (prospect.nextAction ?? '') ? { nextAction } : {}),
        ...((nextActionDueAt ? new Date(nextActionDueAt).toISOString() : null) !==
        (prospect.nextActionDueAt ? new Date(prospect.nextActionDueAt).toISOString() : null)
          ? { nextActionDueAt: nextActionDueAt ? new Date(nextActionDueAt).toISOString() : null }
          : {}),
      }),
    onSuccess: () => {
      toast.success('Prospect saved');
      invalidate();
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const watch = useMutation({
    mutationFn: (watchRequested: boolean) =>
      updateBizDevProspect(api, prospect.id, { watchRequested }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  const openHint = (id: string) => {
    setSearchParams(applyBizDevRoute(searchParams, { prospectId: id }));
  };

  const conflictEffective =
    conflictState.conflictExcluded !== null
      ? conflictState.conflictExcluded
      : prospect.conflictExcluded;
  const reasonDraft =
    conflictState.conflictReason !== null
      ? conflictState.conflictReason
      : (prospect.conflictReason ?? '');

  return (
    <div className="capiro-bizdev__drawer" style={{ gap: 24 }}>
      <div className="capiro-bizdev__meta-row">
        <span className={`capiro-bizdev__stage capiro-bizdev__stage--${prospect.stage}`}>
          {BIZDEV_STAGE_LABELS[prospect.stage]}
        </span>
        {prospect.status === 'dismissed' ? (
          <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">Dismissed</span>
        ) : null}
        {prospect.conflictExcluded ? (
          <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">
            Conflict / excluded
          </span>
        ) : null}
        {prospect.linkedClient ? (
          <button
            type="button"
            className="capiro-bizdev__name-btn"
            onClick={() =>
              window.location.assign(
                `/clients?clientId=${encodeURIComponent(prospect.linkedClient!.id)}`,
              )
            }
          >
            <span className="capiro-bizdev__flag capiro-bizdev__flag--client">
              Client: {prospect.linkedClient.name}
            </span>
          </button>
        ) : null}
      </div>

      <DrawerSection title="Details">
        <div className="capiro-bizdev__field-grid">
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-name">
              Company name
            </label>
            <input
              id="bd-edit-name"
              className="capiro-bizdev__input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-domain">
              Domain
            </label>
            <input
              id="bd-edit-domain"
              className="capiro-bizdev__input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-website">
              Website
            </label>
            <input
              id="bd-edit-website"
              className="capiro-bizdev__input"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              maxLength={500}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-geography">
              Geography
            </label>
            <input
              id="bd-edit-geography"
              className="capiro-bizdev__input"
              value={geography}
              onChange={(e) => setGeography(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-owner">
              Owner
            </label>
            <select
              id="bd-edit-owner"
              className="capiro-bizdev__select"
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {memberName(m)}
                </option>
              ))}
            </select>
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-stage">
              Stage
            </label>
            <select
              id="bd-edit-stage"
              className="capiro-bizdev__select"
              value={stage}
              onChange={(e) => setStage(e.target.value as BizDevStage)}
            >
              {BIZDEV_STAGES.map((s) => (
                <option key={s} value={s}>
                  {BIZDEV_STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-next">
              Next action
            </label>
            <input
              id="bd-edit-next"
              className="capiro-bizdev__input"
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
              maxLength={500}
              placeholder="e.g. Send intro email"
            />
          </div>
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-due">
              Due date
            </label>
            <input
              id="bd-edit-due"
              className="capiro-bizdev__input"
              type="date"
              value={nextActionDueAt}
              onChange={(e) => setNextActionDueAt(e.target.value)}
            />
          </div>
          <div className="capiro-bizdev__field capiro-bizdev__field--full">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-hypothesis">
              Service hypothesis
            </label>
            <input
              id="bd-edit-hypothesis"
              className="capiro-bizdev__input"
              value={serviceHypothesis}
              onChange={(e) => setServiceHypothesis(e.target.value)}
              maxLength={4000}
            />
          </div>
          <div className="capiro-bizdev__field capiro-bizdev__field--full">
            <label className="capiro-bizdev__label" htmlFor="bd-edit-description">
              Description
            </label>
            <textarea
              id="bd-edit-description"
              className="capiro-bizdev__textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4000}
            />
          </div>
        </div>
        <div className="capiro-bizdev__actions" style={{ justifyContent: 'flex-end' }}>
          <CapiroButton
            variant="primary"
            size="compact"
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save changes
          </CapiroButton>
        </div>
      </DrawerSection>

      {watchAlertsEnabled ? (
        <ProspectWatchSection
          tenantId={tenantId}
          prospectId={prospect.id}
          prospectName={prospect.displayName}
          members={members}
          meriEnabled={meriProspectToolsEnabled}
          watchRequested={prospect.watchRequested}
        />
      ) : (
        <DrawerSection title="Watch">
          <div className="capiro-bizdev__actions">
            <CapiroButton
              size="compact"
              variant={prospect.watchRequested ? 'primary' : 'secondary'}
              loading={watch.isPending}
              onClick={() => watch.mutate(!prospect.watchRequested)}
            >
              {prospect.watchRequested ? 'Watching (stored)' : 'Watch this prospect'}
            </CapiroButton>
          </div>
          <StatusNote
            warn
            text="Notifications are not active yet. Your watch choice is saved for later, but nothing will be sent."
          />
        </DrawerSection>
      )}

      <DrawerSection title="Conflict / exclusion">
        {prospect.conflictExcluded ? (
          <StatusNote text="This prospect is marked as a conflict or excluded pursuit." />
        ) : (
          <StatusNote text="No conflict or exclusion is recorded." />
        )}
        {prospect.conflictReason && !isAdmin ? (
          <StatusNote text={`Reason: ${prospect.conflictReason}`} />
        ) : null}
        {isAdmin ? (
          <div className="capiro-bizdev__field">
            <label className="capiro-bizdev__label" htmlFor="bd-conflict-reason">
              Reason (admins only, private to your firm)
            </label>
            <textarea
              id="bd-conflict-reason"
              className="capiro-bizdev__textarea"
              value={reasonDraft}
              onChange={(e) => conflictState.setConflictReason(e.target.value)}
              maxLength={4000}
            />
            <div className="capiro-bizdev__actions">
              <CapiroButton
                size="compact"
                variant={conflictEffective ? 'secondary' : 'primary'}
                loading={conflictState.saveConflict.isPending}
                onClick={() => {
                  const nextExcluded = !conflictEffective;
                  conflictState.setConflictExcluded(nextExcluded);
                  conflictState.saveConflict.mutate({
                    conflictExcluded: nextExcluded,
                    ...(nextExcluded && reasonDraft.trim()
                      ? { conflictReason: reasonDraft.trim() }
                      : {}),
                  });
                }}
              >
                {conflictEffective ? 'Clear exclusion' : 'Mark excluded'}
              </CapiroButton>
            </div>
          </div>
        ) : (
          <StatusNote text="Only firm admins can change the conflict reason." />
        )}
      </DrawerSection>

      <DrawerSection title="Notes">
        <div className="capiro-bizdev__field">
          <label className="capiro-bizdev__label" htmlFor="bd-note">
            New note (private to your firm)
          </label>
          <textarea
            id="bd-note"
            className="capiro-bizdev__textarea"
            value={noteState.noteBody}
            onChange={(e) => noteState.setNoteBody(e.target.value)}
            maxLength={4000}
          />
        </div>
        <div className="capiro-bizdev__actions" style={{ justifyContent: 'flex-end' }}>
          <CapiroButton
            size="compact"
            loading={noteState.addNote.isPending}
            disabled={!noteState.noteBody.trim()}
            onClick={() => noteState.addNote.mutate()}
          >
            Add note
          </CapiroButton>
        </div>
      </DrawerSection>

      <DrawerSection title="History">
        {history.length === 0 ? (
          <StatusNote text="No activity recorded yet." />
        ) : (
          <div className="capiro-bizdev__history">
            {history.map((entry) => (
              <div key={entry.id} className="capiro-bizdev__history-item">
                <span className="capiro-bizdev__history-kind">{entry.kind}</span>
                <span>{entry.body}</span>
                <span className="capiro-bizdev__history-meta">
                  {formatDateShort(entry.createdAt) ?? ''} ·{' '}
                  {entry.kind === 'note' ? 'note added' : 'pipeline event'}
                </span>
              </div>
            ))}
          </div>
        )}
      </DrawerSection>

      {!prospect.canonicalEntityId ? (
        <DrawerSection title="Organization identity">
          <StatusNote
            warn
            text="This is a manual, unresolved prospect. Confirming an organization below links your record to the shared confirmed organization — it never creates or merges one, and history is preserved. The prospect keeps its id, stage, owner, notes, watch setting and client linkage."
          />
          {identityState.hints.length > 0 ? (
            <div>
              <p className="capiro-bizdev__meta">Similar prospects in your firm:</p>
              <ul className="capiro-bizdev__picker-list">
                {identityState.hints.map((hint) => (
                  <li key={hint.id}>
                    <div className="capiro-bizdev__picker-row">
                      <span className="capiro-bizdev__picker-name">{hint.displayName}</span>
                      <CapiroButton size="compact" onClick={() => openHint(hint.id)}>
                        Open
                      </CapiroButton>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {identityState.duplicateNotice ? (
            <div>
              <StatusNote
                warn
                text={`“${identityState.duplicateNotice.displayName}” already holds that organization in your firm. This is a review result — nothing was merged.`}
              />
              <CapiroButton
                size="compact"
                onClick={() => openHint(identityState.duplicateNotice!.prospectId)}
              >
                Open that prospect
              </CapiroButton>
            </div>
          ) : null}
          <div className="capiro-bizdev__actions">
            <input
              className="capiro-bizdev__input capiro-bizdev__input--grow"
              aria-label="Search confirmed organizations"
              value={identityState.orgQuery}
              onChange={(e) => identityState.setOrgQuery(e.target.value)}
              placeholder="Search confirmed organizations by name"
              maxLength={200}
            />
            <CapiroButton
              size="compact"
              loading={identityState.orgSearch.isPending}
              disabled={!identityState.orgQuery.trim()}
              onClick={() => identityState.orgSearch.mutate()}
            >
              Search
            </CapiroButton>
          </div>
          {identityState.orgResults ? (
            identityState.orgResults.length === 0 ? (
              <StatusNote text="No confirmed organizations matched." />
            ) : (
              <ul className="capiro-bizdev__picker-list">
                {identityState.orgResults.map((org) => (
                  <li key={org.id}>
                    <div className="capiro-bizdev__picker-row">
                      <span className="capiro-bizdev__picker-name">
                        {org.canonicalName}
                        {'identityScope' in org && org.identityScope ? (
                          <span className="capiro-bizdev__picker-meta">
                            {' '}
                            ·{' '}
                            {org.identityScope === 'tenant_private'
                              ? 'private to your firm'
                              : 'public shared record'}
                          </span>
                        ) : null}
                      </span>
                      <CapiroButton
                        size="compact"
                        variant="primary"
                        loading={identityState.resolveIdentity.isPending}
                        onClick={() => identityState.resolveIdentity.mutate(org.id)}
                      >
                        Confirm identity
                      </CapiroButton>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </DrawerSection>
      ) : (
        <DrawerSection title="Organization identity">
          <StatusNote
            text={`Confirmed organization: ${prospect.canonicalEntity?.canonicalName ?? 'linked record'}. Its identifiers and source names come from the shared confirmed record.`}
          />
          {dossierEnabled ? (
            <>
              <StatusNote text="If this is the wrong organization, review or correct the identity below. The prospect keeps its id, stage, owner, notes, watch setting and client linkage; histories are never merged." />
              {identityState.duplicateNotice ? (
                <div>
                  <StatusNote
                    warn
                    text={`“${identityState.duplicateNotice.displayName}” already holds that organization in your firm. This is a review result — nothing was merged. Open it to compare instead.`}
                  />
                  <CapiroButton
                    size="compact"
                    onClick={() => openHint(identityState.duplicateNotice!.prospectId)}
                  >
                    Open that prospect
                  </CapiroButton>
                </div>
              ) : (
                <IdentityReviewControls identityState={identityState} />
              )}
              <CapiroButton
                size="compact"
                onClick={() =>
                  setSearchParams(
                    applyBizDevRoute(searchParams, { dossierProspectId: prospect.id }),
                  )
                }
              >
                View evidence dossier
              </CapiroButton>
            </>
          ) : null}
        </DrawerSection>
      )}

      <DrawerSection title="Link or create a client">
        {prospect.linkedClient ? (
          <div className="capiro-bizdev__actions">
            <StatusNote text={`Already linked to client “${prospect.linkedClient.name}”.`} />
          </div>
        ) : (
          <>
            <StatusNote text="This is a deliberate action. Setting the stage to Won does not create a client." />
            <div className="capiro-bizdev__actions" role="radiogroup" aria-label="Conversion mode">
              <button
                type="button"
                className={`capiro-bizdev__filter${convertState.convertMode === 'create' ? ' is-active' : ''}`}
                aria-pressed={convertState.convertMode === 'create'}
                onClick={() => convertState.setConvertMode('create')}
              >
                Create a new client
              </button>
              <button
                type="button"
                className={`capiro-bizdev__filter${convertState.convertMode === 'link' ? ' is-active' : ''}`}
                aria-pressed={convertState.convertMode === 'link'}
                onClick={() => convertState.setConvertMode('link')}
              >
                Link an existing client
              </button>
            </div>
            {convertState.convertMode === 'link' ? (
              <div className="capiro-bizdev__field">
                <div className="capiro-bizdev__actions">
                  <input
                    className="capiro-bizdev__input"
                    style={{ flex: '1 1 200px' }}
                    aria-label="Search your clients"
                    value={convertState.clientQuery}
                    onChange={(e) => convertState.setClientQuery(e.target.value)}
                    placeholder="Search your clients by name"
                    maxLength={200}
                  />
                  <CapiroButton
                    size="compact"
                    loading={convertState.clientSearch.isPending}
                    disabled={!convertState.clientQuery.trim()}
                    onClick={() => convertState.clientSearch.mutate()}
                  >
                    Search
                  </CapiroButton>
                </div>
                {convertState.clientResults ? (
                  <ul className="capiro-bizdev__picker-list">
                    {convertState.clientResults.map((client) => (
                      <li key={client.id}>
                        <div className="capiro-bizdev__picker-row">
                          <span className="capiro-bizdev__picker-name">{client.name}</span>
                          <CapiroButton
                            size="compact"
                            variant={
                              convertState.selectedClientId === client.id ? 'primary' : 'secondary'
                            }
                            onClick={() => convertState.setSelectedClientId(client.id)}
                          >
                            {convertState.selectedClientId === client.id ? 'Selected' : 'Select'}
                          </CapiroButton>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="capiro-bizdev__actions">
              <CapiroButton
                variant="primary"
                size="compact"
                loading={convertState.convert.isPending || convertClicked}
                disabled={
                  convertClicked ||
                  (convertState.convertMode === 'link' && !convertState.selectedClientId)
                }
                onClick={() => {
                  // Pending double-click suppression: the disabled attribute
                  // alone can race a same-tick second click before the
                  // mutation store notifies React, so guard synchronously too.
                  if (convertClicked) return;
                  setConvertClicked(true);
                  convertState.convert.mutate();
                }}
              >
                {convertState.convertMode === 'link'
                  ? 'Link client and mark converted'
                  : 'Create client and mark converted'}
              </CapiroButton>
            </div>
            <StatusNote text="If the request is retried or double-clicked, your firm gets one client — never a duplicate." />
          </>
        )}
      </DrawerSection>

      <DrawerSection title="Dismiss or restore">
        {prospect.status === 'dismissed' ? (
          <div className="capiro-bizdev__actions">
            <StatusNote text="This prospect is dismissed; its history is preserved." />
            <CapiroButton
              size="compact"
              loading={dismissState.restore.isPending}
              onClick={() => dismissState.restore.mutate()}
            >
              Restore
            </CapiroButton>
          </div>
        ) : dismissState.confirmDismiss ? (
          <div className="capiro-bizdev__actions">
            <span className="capiro-bizdev__meta">
              Dismiss this prospect? Its history stays available.
            </span>
            <CapiroButton size="compact" onClick={() => dismissState.setConfirmDismiss(false)}>
              Cancel
            </CapiroButton>
            <CapiroButton
              variant="primary"
              size="compact"
              loading={dismissState.dismiss.isPending}
              onClick={() => dismissState.dismiss.mutate()}
            >
              Confirm dismiss
            </CapiroButton>
          </div>
        ) : (
          <CapiroButton size="compact" onClick={() => dismissState.setConfirmDismiss(true)}>
            Dismiss prospect
          </CapiroButton>
        )}
      </DrawerSection>
    </div>
  );
}

/* ── Phase 5: watch & alerts ────────────────────────────────────────── */

/** Copy that explains the quiet baseline — verified verbatim in tests. */
export const BIZDEV_QUIET_BASELINE_COPY =
  'The first successful check for each source quietly records a starting point (a baseline). It does not send an alert, and it does not dig up historical events — alerts are only about changes observed after that.';

/** Frozen Phase 5 watch-category vocabulary enforced by the API DTO. */
export const BIZDEV_WATCH_CATEGORIES = [
  'contract_award',
  'assistance_award',
  'opportunity',
  'lobbying',
  'acquisition',
  'entity_change',
  'other',
] as const;

const BIZDEV_WATCH_CATEGORY_SET = new Set<string>(BIZDEV_WATCH_CATEGORIES);
const BIZDEV_WATCH_CATEGORY_HELP = `Allowed values: ${BIZDEV_WATCH_CATEGORIES.join(', ')}`;

/** Date line that separates event dates from publication/observation dates. */
function alertDateLine(alert: BizDevProspectAlert): string | null {
  const dates = [
    alert.eventAt
      ? `Event: ${formatDateShort(alert.eventAt) ?? alert.eventAt}`
      : null,
    alert.effectiveAt
      ? `Effective: ${formatDateShort(alert.effectiveAt) ?? alert.effectiveAt}`
      : null,
    alert.publishedAt
      ? `Published: ${formatDateShort(alert.publishedAt) ?? alert.publishedAt}`
      : null,
    alert.firstObservedAt
      ? `First observed: ${formatDateShort(alert.firstObservedAt) ?? alert.firstObservedAt}`
      : null,
  ].filter((value): value is string => value != null);
  return dates.length > 0 ? dates.join(' · ') : null;
}

/** Safe deep link: absolute http(s) only, always opened in a new tab. */
function isSafeSourceUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Phase 5 watch & alerts surface, mounted inside the prospect drawer only
 * when the Phase 5 feature flag is on. Calls ONLY the Business Development
 * watch/alert endpoints — never a provider or external service.
 */
function ProspectWatchSection({
  tenantId,
  prospectId,
  prospectName,
  members,
  meriEnabled,
  watchRequested,
}: {
  tenantId: string;
  prospectId: string;
  prospectName: string;
  members: BizDevMemberOption[];
  meriEnabled: boolean;
  /** Phase 1-4 watchRequested fallback, kept backwards-compatible. */
  watchRequested: boolean;
}) {
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const [categoryDraft, setCategoryDraft] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const watchQuery = useQuery({
    queryKey: bizdevWatchKeys.watch(tenantId, prospectId),
    queryFn: () => getBizDevProspectWatch(api, prospectId),
  });

  const alertsQuery = useQuery({
    queryKey: bizdevWatchKeys.alerts(tenantId, prospectId),
    queryFn: () => getBizDevProspectAlerts(api, prospectId, 25),
    enabled: watchQuery.isSuccess && watchQuery.data?.watch != null,
  });

  const watch = watchQuery.data?.watch ?? null;
  const sources: BizDevWatchSource[] = watchQuery.data?.sources ?? [];
  const alerts = (alertsQuery.data?.items ?? []).filter((a) => !a.dismissedAt);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const ownerName = watch?.ownerUserId ? memberById.get(watch.ownerUserId) : undefined;
  const categoryValue = categoryDraft ?? (watch?.categories ?? []).join(', ');
  const muted = Boolean(watch?.mutedUntil && new Date(watch.mutedUntil).getTime() > Date.now());

  const invalidateWatch = () => {
    void queryClient.invalidateQueries({ queryKey: bizdevWatchKeys.watch(tenantId, prospectId) });
    void queryClient.invalidateQueries({ queryKey: bizdevWatchKeys.alerts(tenantId, prospectId) });
  };

  const onWatchError = (e: unknown) => {
    const message = bizdevErrorMessage(e);
    setActionError(message);
    toast.error(message);
  };
  const onWatchSuccess = (message: string) => {
    setActionError(null);
    toast.success(message);
    invalidateWatch();
  };

  // Typed watch mutations. Each takes its payload as the mutate() variable
  // so a clicked action can never be issued twice or with a stale payload.
  const activate = useMutation({
    mutationFn: (input: BizDevActivateWatchInput) => activateBizDevWatch(api, prospectId, input),
    onSuccess: () => onWatchSuccess('Watch activated'),
    onError: onWatchError,
  });
  const patchWatch = useMutation({
    mutationFn: (input: BizDevUpdateWatchInput) => updateBizDevWatch(api, prospectId, input),
    onSuccess: (_data, input) =>
      onWatchSuccess(
        input.status === 'paused'
          ? 'Watch paused'
          : input.status === 'ended'
            ? 'Watch ended'
            : input.mutedUntil === null && !input.status
              ? 'Watch unmuted'
              : 'Watch updated',
      ),
    onError: onWatchError,
  });
  const [alertAction, setAlertAction] = useState<{ alertId: string; action: 'read' | 'dismiss' } | null>(
    null,
  );
  const alertActionRef = useRef<{ alertId: string; action: 'read' | 'dismiss' } | null>(null);
  const alertBusy = (alertId: string, action: 'read' | 'dismiss') =>
    alertAction?.alertId === alertId && alertAction.action === action;

  const clearAlertAction = () => {
    alertActionRef.current = null;
    setAlertAction(null);
  };

  const markRead = useMutation({
    mutationFn: (alertId: string) => markBizDevAlertRead(api, prospectId, alertId),
    onSuccess: () => {
      clearAlertAction();
      onWatchSuccess('Marked as read');
    },
    onError: (e) => {
      clearAlertAction();
      onWatchError(e);
    },
  });
  const dismissAlert = useMutation({
    mutationFn: (alertId: string) => dismissBizDevAlert(api, prospectId, alertId),
    onSuccess: () => {
      clearAlertAction();
      onWatchSuccess('Alert dismissed');
    },
    onError: (e) => {
      clearAlertAction();
      onWatchError(e);
    },
  });

  const runAlertAction = (alertId: string, action: 'read' | 'dismiss') => {
    // Single-flight guard at the handler level: a second click for the same
    // alert (either action) while one is pending is ignored before any
    // request can be issued, even if the button's disabled state lagged.
    if (alertActionRef.current?.alertId === alertId) return;
    const nextAction = { alertId, action } as const;
    alertActionRef.current = nextAction;
    setAlertAction(nextAction);
    if (action === 'read') markRead.mutate(alertId);
    else dismissAlert.mutate(alertId);
  };

  // Single-flight guard: while any watch mutation is pending, every watch
  // control is disabled so a slow request can never produce a duplicate.
  const anyPending = activate.isPending || patchWatch.isPending;

  const saveCategoryPreferences = () => {
    const categories = splitList(categoryValue);
    const invalid = categories.filter((category) => !BIZDEV_WATCH_CATEGORY_SET.has(category));
    if (invalid.length > 0) {
      const message =
        `Unsupported ${invalid.length === 1 ? 'category' : 'categories'}: ` +
        `${invalid.join(', ')}. ${BIZDEV_WATCH_CATEGORY_HELP}.`;
      setActionError(message);
      return;
    }
    setActionError(null);
    patchWatch.mutate({ categories });
  };

  const errorNote = actionError ? (
    <p role="alert" className="capiro-bizdev__statusnote capiro-bizdev__statusnote--warn">
      {actionError}
    </p>
  ) : null;

  if (watchQuery.isError) {
    return (
      <DrawerSection title="Watch">
        <StatusNote
          warn
          text={`Watch status could not be loaded right now: ${bizdevErrorMessage(watchQuery.error)}`}
        />
      </DrawerSection>
    );
  }

  // No watch yet → offer activation with the quiet-baseline explanation.
  if (!watch) {
    return (
      <DrawerSection title="Watch">
        <CapiroButton
          size="compact"
          variant="primary"
          loading={activate.isPending}
          disabled={anyPending}
          onClick={() => activate.mutate({ ...(categoryValue ? { categories: splitList(categoryValue) } : {}) })}
        >
          {watchRequested ? 'Activate watch for this prospect' : 'Watch this prospect'}
        </CapiroButton>
        <StatusNote text={BIZDEV_QUIET_BASELINE_COPY} />
        {watchRequested ? (
          <StatusNote text="Your earlier watch request was saved. Activating here starts the real source checks." />
        ) : null}
        {errorNote}
      </DrawerSection>
    );
  }

  return (
    <DrawerSection title="Watch">
      <p className="capiro-bizdev__meta">
        Status:{' '}
        <strong>
          {watch.status === 'active' ? 'Active' : watch.status === 'paused' ? 'Paused' : 'Ended'}
        </strong>
        {ownerName ? <> · Watched by {memberName(ownerName)}</> : null}
        {muted && watch.mutedUntil ? (
          <> · Muted until {formatDateShort(watch.mutedUntil) ?? watch.mutedUntil}</>
        ) : null}
      </p>

      <div className="capiro-bizdev__actions">
        {watch.status === 'active' ? (
          <>
            {muted ? (
              <CapiroButton
                size="compact"
                loading={patchWatch.isPending}
                disabled={anyPending}
                onClick={() => patchWatch.mutate({ mutedUntil: null })}
              >
                Resume notifications
              </CapiroButton>
            ) : (
              <CapiroButton
                size="compact"
                loading={patchWatch.isPending}
                disabled={anyPending}
                onClick={() =>
                  patchWatch.mutate({ mutedUntil: new Date(Date.now() + 7 * 864e5).toISOString() })
                }
              >
                Mute for 7 days
              </CapiroButton>
            )}
            <CapiroButton
              size="compact"
              loading={patchWatch.isPending}
              disabled={anyPending}
              onClick={() => patchWatch.mutate({ status: 'paused' })}
            >
              Pause watch
            </CapiroButton>
          </>
        ) : (
          <CapiroButton
            size="compact"
            variant="primary"
            loading={patchWatch.isPending}
            disabled={anyPending}
            onClick={() => patchWatch.mutate({ status: 'active' })}
          >
            {watch.status === 'paused' ? 'Resume watch' : 'Restart watch'}
          </CapiroButton>
        )}
        {watch.status !== 'ended' ? (
          <CapiroButton
            size="compact"
            loading={patchWatch.isPending}
            disabled={anyPending}
            onClick={() => patchWatch.mutate({ status: 'ended' })}
          >
            End watch
          </CapiroButton>
        ) : null}
      </div>

      <p className="capiro-bizdev__meta">
        Last completed check:{' '}
        {watchQuery.data?.lastCompletedCheckAt
          ? (formatDateShort(watchQuery.data.lastCompletedCheckAt) ??
            watchQuery.data.lastCompletedCheckAt)
          : 'none yet — sources have not finished a first check'}
      </p>

      <div className="capiro-bizdev__field">
        <label className="capiro-bizdev__label" htmlFor="bd-watch-categories">
          Category preferences (comma separated)
        </label>
        <div className="capiro-bizdev__actions">
          <input
            id="bd-watch-categories"
            className="capiro-bizdev__input capiro-bizdev__input--grow"
            value={categoryValue}
            onChange={(e) => setCategoryDraft(e.target.value)}
            aria-describedby="bd-watch-categories-help"
            maxLength={400}
          />
          <CapiroButton
            size="compact"
            loading={patchWatch.isPending}
            disabled={anyPending}
            onClick={saveCategoryPreferences}
          >
            Save categories
          </CapiroButton>
        </div>
        <p id="bd-watch-categories-help" className="capiro-bizdev__meta">
          {BIZDEV_WATCH_CATEGORY_HELP}. Leave blank to include all categories.
        </p>
      </div>

      <StatusNote text={BIZDEV_QUIET_BASELINE_COPY} />

      <h4 className="capiro-bizdev__section-title" style={{ fontSize: 13 }}>
        Source health
      </h4>
      {sources.length === 0 ? (
        <StatusNote text="No source checks have been configured for this watch yet." />
      ) : (
        <ul className="capiro-bizdev__history" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {sources.map((source) => (
            <li key={source.source} className="capiro-bizdev__history-item">
              <span className="capiro-bizdev__history-kind">{source.source}</span>
              <span>
                {BIZDEV_SOURCE_HEALTH_LABELS[source.health as BizDevWatchSourceHealth] ??
                  `Health: ${source.health}`}
                {source.lastCheckedAt
                  ? ` · Last check ${formatDateShort(source.lastCheckedAt) ?? source.lastCheckedAt}`
                  : ''}
                {source.detail ? ` · ${source.detail}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {errorNote}
      <div aria-live="polite" className="capiro-bizdev__sr-only" data-testid="bizdev-watch-live">
        {anyPending ? 'Updating watch…' : actionError ? `Watch action failed: ${actionError}` : ''}
      </div>

      <ProspectAlertsPanel
        prospectName={prospectName}
        alerts={alerts}
        alertsPending={alertsQuery.isPending}
        alertsError={alertsQuery.isError ? bizdevErrorMessage(alertsQuery.error) : null}
        meriEnabled={meriEnabled}
        onRead={(alertId) => runAlertAction(alertId, 'read')}
        onDismiss={(alertId) => runAlertAction(alertId, 'dismiss')}
        alertBusy={alertBusy}
      />
    </DrawerSection>
  );
}

/** Prospect Alerts panel — always scoped to the exact prospect. */
function ProspectAlertsPanel({
  prospectName,
  alerts,
  alertsPending,
  alertsError,
  meriEnabled,
  onRead,
  onDismiss,
  alertBusy,
}: {
  prospectName: string;
  alerts: BizDevProspectAlert[];
  alertsPending: boolean;
  alertsError: string | null;
  meriEnabled: boolean;
  onRead: (alertId: string) => void;
  onDismiss: (alertId: string) => void;
  alertBusy: (alertId: string, action: 'read' | 'dismiss') => boolean;
}) {
  return (
    <section aria-label={`Prospect alerts for ${prospectName}`} style={{ display: 'grid', gap: 10 }}>
      <h3 className="capiro-bizdev__section-title" style={{ fontSize: 15 }}>
        Prospect Alerts
      </h3>
      {alertsError ? (
        <StatusNote warn text={`Alerts could not be loaded right now: ${alertsError}`} />
      ) : alertsPending ? (
        <div className="capiro-portfolio__skeleton" style={{ height: 60 }} aria-busy="true" />
      ) : alerts.length === 0 ? (
        <StatusNote text="No alerts for this prospect. When a watched source observes a change after its baseline, it appears here." />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
          {alerts.map((alert) => {
            const dateLine = alertDateLine(alert);
            return (
              <li
                key={alert.id}
                className="capiro-bizdev__surface"
                style={{ padding: 12, display: 'grid', gap: 6 }}
                aria-label={alert.title}
              >
                <div className="capiro-bizdev__title-row">
                  <strong>{alert.title}</strong>
                  {alert.readAt ? <span className="capiro-bizdev__meta">Read</span> : null}
                </div>
                {alert.summary ? <p style={{ margin: 0 }}>{alert.summary}</p> : null}
                {alert.materiality ? (
                  <p className="capiro-bizdev__meta" style={{ margin: 0 }}>
                    Materiality: {alert.materiality}
                  </p>
                ) : null}
                {alert.company || alert.category || alert.sourceFamily ? (
                  <p className="capiro-bizdev__meta" style={{ margin: 0 }}>
                    {[alert.company, alert.category ?? alert.sourceFamily].filter(Boolean).join(' · ')}
                  </p>
                ) : null}
                {dateLine ? <p className="capiro-bizdev__meta" style={{ margin: 0 }}>{dateLine}</p> : null}
                {alert.implication ? (
                  <p className="capiro-bizdev__meta" style={{ margin: 0 }}>
                    Inference: {alert.implication}
                  </p>
                ) : null}
                {isSafeSourceUrl(alert.sourceLocator) ? (
                  <a
                    href={alert.sourceLocator}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="capiro-bizdev__name-btn"
                  >
                    View source record (opens in a new tab)
                  </a>
                ) : null}
                <div className="capiro-bizdev__actions">
                  {!alert.readAt ? (
                    <CapiroButton
                      size="compact"
                      loading={alertBusy(alert.id, 'read')}
                      disabled={alertBusy(alert.id, 'read') || alertBusy(alert.id, 'dismiss')}
                      onClick={() => onRead(alert.id)}
                    >
                      Mark as read
                    </CapiroButton>
                  ) : null}
                  <CapiroButton
                    size="compact"
                    loading={alertBusy(alert.id, 'dismiss')}
                    disabled={alertBusy(alert.id, 'dismiss') || alertBusy(alert.id, 'read')}
                    onClick={() => onDismiss(alert.id)}
                  >
                    Dismiss
                  </CapiroButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {meriEnabled ? (
        <StatusNote
          text={`To ask Meri what changed for ${prospectName}, open the Meri workspace from this page's Meri launcher with this prospect active.`}
        />
      ) : null}
    </section>
  );
}

/* ── preferences ─────────────────────────────────────────────────────── */

/** Parse a draft (string from the textarea) or stored list into tag values. */
function splitList(draft: string | string[]): string[] {
  const raw = Array.isArray(draft) ? draft.join(', ') : draft;
  return raw
    .split(/[\n,]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function PreferencesPanel({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: bizdevKeys.preferences(tenantId),
    queryFn: () => getBizDevPreferences(api),
  });
  const [areas, setAreas] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<string | null>(null);
  const [geos, setGeos] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      saveBizDevPreferences(api, {
        practiceServiceAreas: splitList(areas ?? prefs.data?.practiceServiceAreas ?? []),
        agenciesIssues: splitList(agencies ?? prefs.data?.agenciesIssues ?? []),
        geographies: splitList(geos ?? prefs.data?.geographies ?? []),
      }),
    onSuccess: () => {
      toast.success('Firm preferences saved');
      setAreas(null);
      setAgencies(null);
      setGeos(null);
      void queryClient.invalidateQueries({ queryKey: bizdevKeys.preferences(tenantId) });
    },
    onError: (e) => toast.error(bizdevErrorMessage(e)),
  });

  if (prefs.isPending)
    return <div className="capiro-portfolio__skeleton" style={{ height: 120 }} />;
  if (prefs.isError) {
    return (
      <CapiroErrorState
        title="Preferences are unavailable right now"
        description={bizdevErrorMessage(prefs.error)}
        onRetry={() =>
          void queryClient.resetQueries({
            queryKey: bizdevKeys.preferences(tenantId),
            exact: true,
          })
        }
      />
    );
  }
  const data = prefs.data;
  const areasValue = areas ?? (data?.practiceServiceAreas ?? []).join(', ');
  const agenciesValue = agencies ?? (data?.agenciesIssues ?? []).join(', ');
  const geosValue = geos ?? (data?.geographies ?? []).join(', ');

  return (
    <section
      className="capiro-bizdev__surface capiro-bizdev"
      style={{ gap: 12, padding: 20 }}
      aria-labelledby="bizdev-prefs"
    >
      <h2 className="capiro-bizdev__section-title" id="bizdev-prefs">
        Firm business-development preferences
      </h2>
      <p className="capiro-bizdev__meta">
        {isAdmin
          ? 'Small lists your firm uses to frame pursuits. Private to your firm.'
          : 'View only — only firm admins can save changes to these lists.'}
      </p>
      <div className="capiro-bizdev__field-grid">
        {(
          [
            ['Practice / service areas', areasValue, setAreas, 'prefs-areas'],
            ['Agencies and issues', agenciesValue, setAgencies, 'prefs-agencies'],
            ['Geographies', geosValue, setGeos, 'prefs-geos'],
          ] as const
        ).map(([label, value, setter, id]) => (
          <div key={id} className="capiro-bizdev__field capiro-bizdev__field--full">
            <label className="capiro-bizdev__label" htmlFor={`bd-${id}`}>
              {label}
            </label>
            {isAdmin ? (
              <textarea
                id={`bd-${id}`}
                className="capiro-bizdev__textarea"
                style={{ minHeight: 56 }}
                value={value}
                onChange={(e) => setter(e.target.value)}
              />
            ) : (
              <div className="capiro-bizdev__pref-list">
                {value
                  .split(/,\s*/)
                  .filter(Boolean)
                  .map((tag) => (
                    <span key={tag} className="capiro-bizdev__pref-tag">
                      {tag}
                    </span>
                  ))}
                {!value.trim() ? <span className="capiro-bizdev__meta">None saved yet</span> : null}
              </div>
            )}
          </div>
        ))}
      </div>
      {isAdmin ? (
        <div className="capiro-bizdev__actions" style={{ justifyContent: 'flex-end' }}>
          <CapiroButton
            variant="primary"
            size="compact"
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save preferences
          </CapiroButton>
        </div>
      ) : null}
    </section>
  );
}

/* ── pipeline (list) ─────────────────────────────────────────────────── */

/** v5 view tab bar: Discover / Pipeline / Watchlist, URL-deep-linked. */
function BizDevViewTabs({
  view,
  counts,
  onSelect,
  discoverEnabled,
  watchAlertsEnabled,
}: {
  view: BizDevView;
  counts: { active: number; dismissed: number };
  onSelect: (view: BizDevView) => void;
  discoverEnabled: boolean;
  watchAlertsEnabled: boolean;
}) {
  const tabs: Array<{ view: BizDevView; count: string | null }> = [
    { view: 'discover', count: null },
    { view: 'pipeline', count: String(counts.active) },
    { view: 'watchlist', count: null },
  ];
  return (
    <div className="capiro-bizdev__viewtabs" role="tablist" aria-label="Business Development views">
      {tabs
        .filter((t) => t.view !== 'discover' || discoverEnabled)
        .filter((t) => t.view !== 'watchlist' || watchAlertsEnabled)
        .map((t) => (
          <button
            key={t.view}
            type="button"
            role="tab"
            id={`bizdev-view-${t.view}`}
            aria-selected={view === t.view}
            aria-controls="bizdev-viewpanel"
            className={`capiro-bizdev__viewtab${view === t.view ? ' is-active' : ''}`}
            onClick={() => onSelect(t.view)}
          >
            {BIZDEV_VIEW_LABELS[t.view]}
            {t.count != null ? (
              <span className="capiro-bizdev__viewtab-count" aria-label={`${t.count} prospects`}>
                {t.count}
              </span>
            ) : null}
          </button>
        ))}
    </div>
  );
}

/** v5 stage summary/histogram from the real list counts.byStage. */
function BizDevStageHistogram({
  byStage,
  selectedStage,
  onSelect,
}: {
  byStage: Record<string, number>;
  selectedStage: BizDevStage | '';
  onSelect: (stage: BizDevStage | '') => void;
}) {
  const maxCount = Math.max(0, ...BIZDEV_STAGES.map((stage) => byStage[stage] ?? 0));
  return (
    <div className="capiro-bizdev__stagebar" aria-label="Prospects by stage">
      {BIZDEV_STAGES.map((stage) => {
        const count = byStage[stage] ?? 0;
        const selected = selectedStage === stage;
        return (
          <button
            key={stage}
            type="button"
            className={`capiro-bizdev__stagecell${selected ? ' is-active' : ''}${stage === 'won' ? ' capiro-bizdev__stagecell--won' : ''}`}
            aria-pressed={selected}
            onClick={() => onSelect(selected ? '' : stage)}
            aria-label={`${BIZDEV_STAGE_LABELS[stage]}: ${count}`}
          >
            <span className="capiro-bizdev__stagecell-label">{BIZDEV_STAGE_LABELS[stage]}</span>
            <span className="capiro-bizdev__stagecell-count">{count}</span>
            <span className="capiro-bizdev__stagecell-track" aria-hidden="true">
              <span
                className="capiro-bizdev__stagecell-bar"
                style={{ width: `${maxCount ? (count / maxCount) * 100 : 0}%` }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Pipeline({
  tenantId,
  isAdmin,
  dossierEnabled,
  briefEnabled,
  meriProspectToolsEnabled,
  watchAlertsEnabled,
}: {
  tenantId: string;
  isAdmin: boolean;
  dossierEnabled: boolean;
  briefEnabled: boolean;
  meriProspectToolsEnabled: boolean;
  watchAlertsEnabled: boolean;
}) {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolveBizDevRoute(searchParams);
  const members = useQuery({
    queryKey: bizdevKeys.members(tenantId),
    queryFn: () => getBizDevMemberOptions(api),
  });
  const list = useQuery({
    queryKey: bizdevKeys.lists(tenantId, bizDevListQuery(route)),
    queryFn: () => listBizDevProspects(api, bizDevListQuery(route)),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const members_ = members.data ?? [];
  const memberById = new Map(members_.map((m) => [m.id, m]));

  const setRoute = (patch: Parameters<typeof applyBizDevRoute>[1]) =>
    setSearchParams(applyBizDevRoute(searchParams, patch));

  const openProspect = (id: string) => setRoute({ prospectId: id });

  const rowsAll = list.data?.prospects ?? [];
  // Derived overdue-only toggle: pure client-side filter over the loaded
  // nextActionDueAt values. There is no overdue/priority field in the API.
  const rows = route.overdueOnly
    ? rowsAll.filter((p) => isBizDevOverdue(p.nextActionDueAt))
    : rowsAll;
  const hasData = Boolean(list.data) && (list.data?.counts.total ?? 0) > 0;

  const setView = (view: BizDevView) =>
    // Switching views keeps filters/params; Discover keeps its legacy param
    // in sync so old links and new links are interchangeable.
    setRoute({
      view,
      ...(view === 'discover'
        ? { discover: 'open' as const }
        : { discover: '' as const }),
    });

  const drawer = route.prospectId ? (
    <ProspectDrawer
      tenantId={tenantId}
      prospectId={route.prospectId}
      members={members_}
      isAdmin={isAdmin}
      dossierEnabled={dossierEnabled}
      briefEnabled={briefEnabled}
      meriProspectToolsEnabled={meriProspectToolsEnabled}
      watchAlertsEnabled={watchAlertsEnabled}
      onClose={() => void list.refetch()}
    />
  ) : null;
  const dossierDrawer =
    route.dossierEntityId || route.dossierProspectId ? (
      <DossierDrawer tenantId={tenantId} />
    ) : null;

  const countsActive = list.data?.counts.active ?? 0;
  const countsDismissed = list.data?.counts.dismissed ?? 0;
  const requestedView: BizDevView = route.discover === 'open' ? 'discover' : route.view;
  // View feature gates fail closed even for direct/deep-linked URLs. The API
  // independently applies the same gates; this keeps the tablist and panel in
  // a truthful, accessible state without mounting a disabled surface.
  const view: BizDevView =
    (requestedView === 'discover' && !dossierEnabled) ||
    (requestedView === 'watchlist' && !watchAlertsEnabled)
      ? 'pipeline'
      : requestedView;

  return (
    <div className="capiro-bizdev capiro-page">
      <header className="capiro-bizdev__head">
        <div>
          <p className="capiro-bizdev__eyebrow">Portfolio</p>
          <h1 className="capiro-bizdev__title">Business Development</h1>
          <p className="capiro-bizdev__sub">
            Your firm's private prospect pipeline — research to won.
          </p>
        </div>
        <span className="capiro-bizdev__head-spacer" />
        <CapiroIconButton
          className="capiro-bizdev__preferences-button"
          label="Preferences"
          icon="⚙"
          onClick={() => setPreferencesOpen(true)}
        />
        <CapiroButton variant="primary" size="standard" onClick={() => setCreateOpen(true)}>
          Add prospect
        </CapiroButton>
      </header>

      <BizDevViewTabs
        view={view}
        counts={{ active: countsActive, dismissed: countsDismissed }}
        onSelect={setView}
        discoverEnabled={dossierEnabled}
        watchAlertsEnabled={watchAlertsEnabled}
      />

      <div id="bizdev-viewpanel" role="tabpanel" aria-label="Business Development view">
      {view === 'watchlist' ? (
        <BizDevWatchlist
          tenantId={tenantId}
          members={members_}
          watchAlertsEnabled={watchAlertsEnabled}
        />
      ) : view === 'discover' ? (
        <DiscoverPanel tenantId={tenantId} />
      ) : (
      <section className="capiro-bizdev__surface" aria-labelledby="bizdev-pipeline">
        <div className="capiro-bizdev__toolbar">
          <div className="capiro-bizdev__title-row">
            <h2 className="capiro-bizdev__section-title" id="bizdev-pipeline">
              Pipeline
            </h2>
            <span className="capiro-bizdev__count">
              {list.isPending
                ? '…'
                : `${rows.length} of ${list.data?.counts.visible ?? 0} prospects`}
            </span>
          </div>
          <span className="capiro-bizdev__toolbar-spacer" />
          {hasData ? <BizDevFilters members={members_} /> : null}
          {hasBizDevFilters(route) ? (
            <CapiroButton
              size="compact"
              onClick={() =>
                setRoute({
                  stage: '',
                  ownerId: '',
                  status: 'active',
                  conflict: '',
                  linkedClient: '',
                  q: '',
                  overdueOnly: false,
                })
              }
            >
              Clear filters
            </CapiroButton>
          ) : null}
        </div>

        {/* Derived overdue toggle; status is selected in the filter toolbar. */}
        <div className="capiro-bizdev__segment-row">
          <label className="capiro-bizdev__toggle">
            <input
              type="checkbox"
              checked={route.overdueOnly}
              onChange={(e) => setRoute({ overdueOnly: e.target.checked })}
            />
            <span>Overdue only (derived from next-action due dates)</span>
          </label>
        </div>

        {!list.isPending && list.data ? (
          <div className="capiro-bizdev__stagebar-wrap">
            <BizDevStageHistogram
              byStage={list.data.counts.byStage}
              selectedStage={route.stage}
              onSelect={(stage) => setRoute({ stage })}
            />
          </div>
        ) : null}

        {list.isPending ? (
          <div style={{ padding: 24 }} aria-busy="true">
            <div className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall" />
          </div>
        ) : list.isError ? (
          <div style={{ padding: 24 }}>
            <CapiroErrorState
              title="The pipeline could not be loaded"
              description={bizdevErrorMessage(list.error)}
              onRetry={() => void list.refetch()}
              retryLabel="Retry"
            />
          </div>
        ) : rows.length === 0 && !hasData ? (
          <div style={{ padding: 24 }}>
            <CapiroEmptyState
              variant="first-use"
              title="No prospects yet"
              description="Add the first company your firm is pursuing. Everything here is private to your firm."
              action={
                <CapiroButton variant="primary" size="compact" onClick={() => setCreateOpen(true)}>
                  Add prospect
                </CapiroButton>
              }
            />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24 }}>
            <CapiroEmptyState
              variant="search-empty"
              title="No prospects match the current filters"
              action={
                <CapiroButton
                  size="compact"
                  onClick={() =>
                    setRoute({
                      stage: '',
                      ownerId: '',
                      status: 'active',
                      conflict: '',
                      linkedClient: '',
                      q: '',
                      overdueOnly: false,
                    })
                  }
                >
                  Clear filters
                </CapiroButton>
              }
            />
          </div>
        ) : (
          <div className="capiro-bizdev__table-wrap">
            <table className="capiro-bizdev__table">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Next action</th>
                  <th scope="col">Flags</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="capiro-bizdev__tr">
                    <td>
                      <button
                        type="button"
                        className="capiro-bizdev__name-btn"
                        onClick={() => openProspect(p.id)}
                      >
                        {p.displayName}
                        {p.canonicalEntity ? (
                          <span className="capiro-bizdev__meta" style={{ display: 'block' }}>
                            Confirmed organization
                          </span>
                        ) : null}
                      </button>
                    </td>
                    <td>
                      {p.ownerUserId && memberById.get(p.ownerUserId) ? (
                        <span className="capiro-bizdev__meta-row">
                          <span className="capiro-portfolio__avatar" aria-hidden>
                            {initials(memberName(memberById.get(p.ownerUserId)))}
                          </span>
                          {memberName(memberById.get(p.ownerUserId))}
                        </span>
                      ) : (
                        <span className="capiro-bizdev__meta">Unassigned</span>
                      )}
                    </td>
                    <td>
                      <span className={`capiro-bizdev__stage capiro-bizdev__stage--${p.stage}`}>
                        {BIZDEV_STAGE_LABELS[p.stage]}
                      </span>
                    </td>
                    <td>
                      {p.nextAction ? (
                        <span className="capiro-bizdev__meta-row">
                          {p.nextAction}
                          {p.nextActionDueAt ? (
                            <span className="capiro-bizdev__meta">
                              · due {formatDateShort(p.nextActionDueAt) ?? ''}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="capiro-bizdev__meta">—</span>
                      )}
                    </td>
                    <td>
                      <span className="capiro-bizdev__meta-row">
                        {p.conflictExcluded ? (
                          <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">
                            Conflict
                          </span>
                        ) : null}
                        {p.status === 'dismissed' ? (
                          <span className="capiro-bizdev__flag capiro-bizdev__flag--conflict">
                            Dismissed
                          </span>
                        ) : null}
                        {p.linkedClient ? (
                          <span className="capiro-bizdev__flag capiro-bizdev__flag--client">
                            Client
                          </span>
                        ) : null}
                        {!p.conflictExcluded && p.status !== 'dismissed' && !p.linkedClient ? (
                          <span className="capiro-bizdev__meta">—</span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <span className="capiro-bizdev__meta">
                        {formatDateShort(p.updatedAt) ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data ? (
          <div className="capiro-bizdev__footer">
            Active {list.data.counts.active} · Dismissed {list.data.counts.dismissed} · Total{' '}
            {list.data.counts.total}
          </div>
        ) : null}
      </section>

      )}
      </div>

      <CapiroDrawer
        open={preferencesOpen}
        title="Firm business-development preferences"
        onClose={() => setPreferencesOpen(false)}
        width={640}
      >
        <PreferencesPanel tenantId={tenantId} isAdmin={isAdmin} />
      </CapiroDrawer>

      {createOpen ? (
        <CreateProspectModal
          members={members_}
          onClose={() => setCreateOpen(false)}
          onOpenExisting={(id) => {
            setCreateOpen(false);
            setRoute({ prospectId: id, status: 'all' });
          }}
          onCreated={(prospect) => {
            setCreateOpen(false);
            void list.refetch();
            setRoute({ prospectId: prospect.id, status: 'all' });
          }}
        />
      ) : null}

      {drawer}
      {dossierDrawer}
    </div>
  );
}

/* ── entry: flag-gated ───────────────────────────────────────────────── */

/**
 * Portfolio → Business Development (Phase 1).
 *
 * FAILS CLOSED on `me.features.businessDevelopment`: absent, loading, errored
 * or false all render the ordinary Clients Portfolio instead — the view, its
 * queries and its endpoints only exist when the tenant flag is exactly true.
 * The API independently 404s every business-development route when off.
 */
export function BusinessDevelopmentPage() {
  const me = useMe();
  if (me.data?.features.businessDevelopment === true) {
    return (
      <Pipeline
        tenantId={me.data.tenant.id}
        isAdmin={hasAtLeast(me.data.role, 'user_admin')}
        dossierEnabled={me.data.features.businessDevelopmentDossier === true}
        briefEnabled={me.data.features.businessDevelopmentBrief === true}
        meriProspectToolsEnabled={me.data.features.businessDevelopmentMeriProspectTools === true}
        watchAlertsEnabled={me.data.features.businessDevelopmentWatch === true}
      />
    );
  }
  return <PortfolioIndexPage />;
}
