import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { UseMutationResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hasAtLeast } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { formatDateShort } from '../../lib/labels.js';
import { PortfolioIndexPage } from '../portfolio/PortfolioIndexPage.js';
import {
  applyBizDevRoute,
  BIZDEV_CONFLICT_FILTERS,
  BIZDEV_STAGES,
  BIZDEV_STAGE_LABELS,
  BIZDEV_STATUSES,
  BIZDEV_STATUS_LABELS,
  bizDevListQuery,
  hasBizDevFilters,
  resolveBizDevRoute,
  type BizDevStage,
} from './bizdev-routing.js';
import {
  addBizDevNote,
  bizdevErrorMessage,
  bizdevKeys,
  convertBizDevProspect,
  createBizDevProspect,
  dismissBizDevProspect,
  getBizDevDuplicateHints,
  getBizDevHistory,
  getBizDevMemberOptions,
  getBizDevPreferences,
  getBizDevProspect,
  listBizDevProspects,
  previewBizDevDuplicateHints,
  restoreBizDevProspect,
  saveBizDevPreferences,
  searchBizDevCanonicalOrganizations,
  searchBizDevClients,
  updateBizDevConflict,
  updateBizDevProspect,
  resolveBizDevIdentity,
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

/* ── filters toolbar ────────────────────────────────────────────────── */

function BizDevFilters({ members }: { members: BizDevMemberOption[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const route = resolveBizDevRoute(searchParams);
  const setRoute = (patch: Parameters<typeof applyBizDevRoute>[1]) =>
    setSearchParams(applyBizDevRoute(searchParams, patch));

  return (
    <div className="capiro-bizdev__filters" aria-label="Pipeline filters">
      <label className="capiro-bizdev__label" htmlFor="bizdev-search">
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
      {BIZDEV_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          className={`capiro-bizdev__filter${route.status === s ? ' is-active' : ''}`}
          aria-pressed={route.status === s}
          onClick={() => setRoute({ status: s })}
        >
          {BIZDEV_STATUS_LABELS[s]}
        </button>
      ))}
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
  onClose,
}: {
  tenantId: string;
  prospectId: string;
  members: BizDevMemberOption[];
  isAdmin: boolean;
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

  return (
    <CapiroDrawer open title={`Prospect — ${prospect.displayName}`} onClose={close} width={560}>
      <ProspectDrawerBody
        key={prospect.id + prospect.updatedAt}
        prospect={prospect}
        members={members}
        isAdmin={isAdmin}
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
  prospect,
  members,
  isAdmin,
  api,
  invalidate,
  history,
  noteState,
  dismissState,
  convertState,
  identityState,
  conflictState,
}: {
  prospect: BizDevProspect;
  members: BizDevMemberOption[];
  isAdmin: boolean;
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
            text="This is a manual, unresolved prospect. Confirming an organization below links your record to the shared confirmed organization — it never creates or merges one, and history is preserved."
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
                text={`“${identityState.duplicateNotice.displayName}” already holds that organization in your firm.`}
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
              className="capiro-bizdev__input"
              style={{ flex: '1 1 200px' }}
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
                      <span className="capiro-bizdev__picker-name">{org.canonicalName}</span>
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
            text={`Confirmed organization: ${prospect.canonicalEntity?.canonicalName ?? 'linked record'}`}
          />
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

function Pipeline({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
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
  const members_ = members.data ?? [];
  const memberById = new Map(members_.map((m) => [m.id, m]));

  const setRoute = (patch: Parameters<typeof applyBizDevRoute>[1]) =>
    setSearchParams(applyBizDevRoute(searchParams, patch));

  const openProspect = (id: string) => setRoute({ prospectId: id });

  const rows = list.data?.prospects ?? [];
  const hasData = Boolean(list.data) && (list.data?.counts.total ?? 0) > 0;

  return (
    <div className="capiro-bizdev capiro-page">
      <header className="capiro-bizdev__head">
        <div>
          <h1 className="capiro-bizdev__title">Business Development</h1>
          <p className="capiro-bizdev__sub">
            Your firm's private prospect pipeline — research to won.
          </p>
        </div>
        <span className="capiro-bizdev__head-spacer" />
        <CapiroButton variant="primary" size="standard" onClick={() => setCreateOpen(true)}>
          Add prospect
        </CapiroButton>
      </header>

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
                })
              }
            >
              Clear filters
            </CapiroButton>
          ) : null}
        </div>

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

      <PreferencesPanel tenantId={tenantId} isAdmin={isAdmin} />

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

      {route.prospectId ? (
        <ProspectDrawer
          tenantId={tenantId}
          prospectId={route.prospectId}
          members={members_}
          isAdmin={isAdmin}
          onClose={() => void list.refetch()}
        />
      ) : null}
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
      <Pipeline tenantId={me.data.tenant.id} isAdmin={hasAtLeast(me.data.role, 'user_admin')} />
    );
  }
  return <PortfolioIndexPage />;
}
