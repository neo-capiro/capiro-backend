/**
 * Builder step 5 — Targets.
 *
 * Three tabs (Directory / Saved audiences / Selected), the list-vs-group
 * builder, and the campaign's current recipients. Two mappings onto the real
 * Campaign Spec are worth stating up front, because both diverge from the
 * prototype and neither is an accident:
 *
 * 1. THE BUILDER'S MEMBERS ARE THE CAMPAIGN'S SELECTED TARGETS. The prototype
 *    keeps `abuilder.members` as a set entirely independent of `dsel`, seeded
 *    empty, collected by re-purposing the Directory's `+` control. That cannot
 *    survive contact with the real API for two reasons: a Directory row is
 *    added by locator (`{source,id}`) and only the server's re-resolution knows
 *    the person's name and address, and `POST /outreach/audiences` validates
 *    every member with `@IsEmail()`. So a member has to be a resolved target
 *    before it can be saved. Saving a GROUP additionally sets the campaign's
 *    delivery pattern to `shared_thread` — a campaign-level fact — which only
 *    makes sense if the group IS the campaign's audience. Building a list is
 *    therefore "name and save the recipients you have chosen", which is also
 *    exactly what the repo's own `SavedTargetListsPanel` already did.
 *
 * 2. APPLYING A SAVED AUDIENCE REALLY ADDS ITS MEMBERS. The prototype only
 *    flips `aapplied[id]` and toasts, so the card reads "Saved" while the
 *    Review step still shows the old recipients (00-GAP §4.6 names this as a
 *    defect). Here `apply` issues `ADD_TARGET_REFS` for every member and sets
 *    the matching delivery pattern, and "applied" is derived from the campaign
 *    rather than from a local flag, so it cannot claim a state the spec is not
 *    actually in.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Mail, Plus, Users, X } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import type {
  OutreachV3ResolvedTargetRef,
  OutreachV3TargetCandidate,
  OutreachV3TargetLocator,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  addTargetCommand,
  deliveryCommands,
  removeTargetCommand,
  setTargetCcBccCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import {
  getOutreachV3TargetProfile,
  getOutreachV3TargetRelationships,
  safeOutreachV3Error,
  searchOutreachV3Targets,
} from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import { TargetDirectoryBrowser } from '../../../pages/engagement/outreach/v3/TargetDirectoryBrowser.js';
import { MANUAL_AUDIENCE_OPTIONS } from '../../../pages/engagement/outreach/v3/TargetWorkspace.js';
import type {
  DirectoryCommittee,
  DirectoryCommitteesResponse,
  DirectoryCommitteeStaffer,
  DirectoryCommitteeStaffResponse,
} from '../../../pages/directory/directoryData.js';
import {
  createSavedOutreachAudience,
  listSavedOutreachAudiences,
  type CreateSavedOutreachAudienceMemberInput,
  type SavedAudience,
  type SavedAudienceMember,
} from './engagement-api.js';
import {
  outreachSameOfficeGroups,
  outreachSameOfficeWarning,
  outreachSelectedTargets,
  outreachTargetIsSendable,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import './outreach-step-targets.css';
/*
 * `TargetDirectoryBrowser` is deliberately css-free: its `.ov3-*` rules live in
 * the canonical `outreach-v3.css` / `target-workspace.css`, whose vNext-token
 * ports are pre-generated into these two files (structural rules, then the
 * `--ov3-*` -> `--eng-*` remap). Both are scoped to
 * `.capiro-vnext-root .engagement-vnext`, which this step renders inside, so
 * importing them here is enough. Without them the Directory table renders with
 * no styling at all.
 */
import './outreach-decision-vnext.css';
import './outreach-body-vnext.css';

type OutreachTargetsTab =
  | 'Directory'
  | 'State legislators'
  | 'Committee staff'
  | 'Add manually'
  | 'Saved audiences'
  | 'Selected';

type OutreachAudienceKind = 'list' | 'group';

export interface OutreachTargetsStepProps extends OutreachBuilderStepCommon {
  selectedClientId: string | null;
}

const AUDIENCES_QUERY_KEY = ['outreach-v3', 'saved-target-lists'] as const;

/**
 * The audience API validates every member with `@IsEmail()`, so one unusable
 * address 400s the whole save. Same regex `SavedTargetListsPanel` pre-filters
 * with — kept identical so the two callers cannot disagree about who is
 * saveable. `outreachTargetIsSendable` is the emailStatus-aware check; this
 * adds the format check the endpoint itself applies.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function audienceEmailable(target: OutreachV3ResolvedTargetRef): boolean {
  return outreachTargetIsSendable(target) && EMAIL_RE.test((target.email ?? '').trim());
}

/**
 * Local copy of `outreach-v3-saved-target-lists.tsx`'s `targetToAudienceMemberInput`
 * — that module keeps it private and this build may not edit it. `source` is a
 * re-resolution hint, not the original locator source, which is why the two
 * directory sources collapse onto 'congress' exactly as Outreach 2.0 does.
 */
function targetToAudienceMemberInput(
  target: OutreachV3ResolvedTargetRef,
): CreateSavedOutreachAudienceMemberInput {
  const source: CreateSavedOutreachAudienceMemberInput['source'] =
    target.locator.source === 'directory_member' || target.locator.source === 'directory_staff'
      ? 'congress'
      : target.clientId
        ? 'client_contact'
        : 'manual';
  return {
    source,
    sourceRefId: typeof target.locator.id === 'string' ? target.locator.id : undefined,
    name: target.displayName || undefined,
    email: (target.email ?? '').trim(),
    title: target.title ?? undefined,
    office: target.organization ?? undefined,
  };
}

/**
 * The locator to re-add a saved audience member with.
 *
 * NOT `savedAudienceMemberLocator` from TargetWorkspace: that helper trusts
 * `member.source`, but the source stored on a saved audience is a coarse
 * re-resolution hint — `congress` / `client_contact` / `manual` (see
 * `targetToAudienceMemberInput` above) — and `congress` is not one of the six
 * sources `OutreachTargetReferenceService.resolveOneWithinTx` knows. Adding a
 * saved congressional contact with it fails resolution outright, which is the
 * whole point of the Saved tab.
 *
 * A `manual` locator built from the member's own stored fields does resolve.
 * The cost is honest and visible: the server marks it `roleStatus: 'unknown'`
 * and `profileStatus: 'limited'` rather than re-verifying the person against
 * the Directory. `congress` cannot be mapped back to `directory_member` vs
 * `directory_staff` — the audience row does not record which — so guessing
 * would trade a failure for a wrong answer.
 */
function savedMemberLocator(member: SavedAudienceMember): OutreachV3TargetLocator {
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

function contactCount(n: number): string {
  return n === 1 ? '1 contact' : `${n} contacts`;
}

/**
 * The prototype's kind stamp is only ever Member or Staffer, because its seed
 * directory is the only source it has. Real targets arrive from five locator
 * sources, so the ones it never met read as their own source rather than being
 * forced into one of the two it knew about.
 */
const TARGET_KIND_LABEL: Record<string, string> = {
  directory_member: 'Member',
  directory_staff: 'Staffer',
  state_legislator: 'State legislator',
  committee_staff: 'Committee staff',
  client_contact: 'Client contact',
  manual: 'Manual',
};

function targetKindLabel(target: OutreachV3ResolvedTargetRef): string {
  const source = target.locator.source;
  return TARGET_KIND_LABEL[source] ?? source.replace(/_/g, ' ');
}

/**
 * `role · office` as the prototype composes it in markup, minus the parts a
 * real ref can be missing — the prototype has no guard because its seed rows
 * always carry both, and a leading " · " is a rendering bug, not copy.
 */
function targetSubline(target: OutreachV3ResolvedTargetRef): string {
  return [target.title, target.organization]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' · ');
}

/**
 * "Add manually" tab. Ports `TargetWorkspace.tsx`'s `addManual` flow: same
 * required-name / optional-but-validated-email / required-audienceType
 * gating (a manual target has no directory signal for
 * government-affairs-policy.registry's selectPolicy() to key off, so it
 * fails closed at generation without one — refusing here, where the person
 * can still fix it, is cheaper than discovering it later).
 */
function AddManuallyPanel({
  busy,
  applyCommands,
}: {
  busy: boolean;
  applyCommands: (commands: ReturnType<typeof addTargetCommand>[]) => Promise<unknown>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [organization, setOrganization] = useState('');
  const [note, setNote] = useState('');
  const [audienceType, setAudienceType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setError('Enter the target name.');
      return;
    }
    if (email.trim() && !EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address or leave the email blank.');
      return;
    }
    if (!audienceType) {
      setError('Choose an audience type — Capiro will not guess government-affairs etiquette.');
      return;
    }
    const locator: OutreachV3TargetLocator = {
      source: 'manual',
      id: crypto.randomUUID(),
      name: name.trim(),
      email: email.trim() || null,
      phone: phone.trim() || null,
      title: title.trim() || null,
      organization: organization.trim() || null,
      note: note.trim() || null,
      audienceType,
    };
    setError(null);
    setPending(true);
    try {
      await applyCommands([addTargetCommand(locator)]);
      setName('');
      setEmail('');
      setPhone('');
      setTitle('');
      setOrganization('');
      setNote('');
      setAudienceType('');
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="ocb-card ots-manual">
      <label className="ocb-field">
        <span className="ocb-field__label">Name</span>
        <input className="ocb-input" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="ocb-field">
        <span className="ocb-field__label">Email</span>
        <input
          className="ocb-input"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="ocb-field">
        <span className="ocb-field__label">Phone</span>
        <input className="ocb-input" value={phone} onChange={(event) => setPhone(event.target.value)} />
      </label>
      <label className="ocb-field">
        <span className="ocb-field__label">Title</span>
        <input className="ocb-input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="ocb-field">
        <span className="ocb-field__label">Organization</span>
        <input
          className="ocb-input"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
        />
      </label>
      <label className="ocb-field">
        <span className="ocb-field__label">Audience type</span>
        <select
          className="ocb-input"
          value={audienceType}
          onChange={(event) => setAudienceType(event.target.value)}
        >
          {MANUAL_AUDIENCE_OPTIONS.map((option) => (
            <option key={option.value || 'unset'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="ocb-note ocb-note--muted">
        Capiro applies different government-affairs etiquette by audience and will not guess.
        Choose an audience before adding this target — generation stays blocked for it otherwise.
      </p>
      <label className="ocb-field">
        <span className="ocb-field__label">Note</span>
        <textarea
          className="ocb-input"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {error ? (
        <p className="ocb-note ocb-note--warn" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className="ocb-btn ocb-btn--primary ocb-btn--sm"
        disabled={busy || pending || !name.trim() || !audienceType}
        onClick={() => void submit()}
      >
        {pending ? <Loader2 size={14} className="ots-spin" aria-hidden="true" /> : null}
        Add target to campaign
      </button>
    </div>
  );
}

/**
 * "State legislators" tab. Reuses the governed `search_targets` capability
 * exactly like `TargetWorkspace.tsx`'s 'statelegislators' source tab does,
 * but hits it directly via `searchOutreachV3Targets` (already wired for
 * another vNext surface) instead of threading `searchTargets`/
 * `targetCandidates` through this step's props — a lean, standalone query
 * scoped to one source is simpler here than lifting that whole controller.
 */
function StateLegislatorsPanel({
  sessionId,
  selected,
  busy,
  applyCommands,
}: {
  sessionId: string;
  selected: OutreachV3ResolvedTargetRef[];
  busy: boolean;
  applyCommands: (commands: ReturnType<typeof addTargetCommand>[]) => Promise<unknown>;
}): JSX.Element {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const search = useQuery({
    queryKey: ['outreach-v3', 'target-search', sessionId, 'state_legislator', query],
    queryFn: () =>
      searchOutreachV3Targets(api, sessionId, {
        query: query.trim() || undefined,
        sources: ['state_legislator'],
        limit: 25,
      }),
  });

  const selectedByKey = useMemo(() => {
    const map = new Map<string, OutreachV3ResolvedTargetRef>();
    for (const target of selected) map.set(target.targetKey, target);
    return map;
  }, [selected]);

  const add = async (candidate: OutreachV3TargetCandidate) => {
    setError(null);
    try {
      await applyCommands([addTargetCommand(candidate.locator)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const candidates = search.data?.data.candidates ?? [];

  return (
    <div className="ocb-stack">
      <input
        className="ocb-input"
        placeholder="Search state legislators by name, chamber, or state…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? (
        <p className="ocb-note ocb-note--warn" role="alert">
          {error}
        </p>
      ) : null}
      {search.isLoading ? (
        <p className="ocb-empty">Searching state legislators…</p>
      ) : search.isError ? (
        <p className="ocb-empty" role="alert">
          {safeOutreachV3Error(search.error)}
        </p>
      ) : candidates.length === 0 ? (
        <p className="ocb-empty">No matching state legislators. Try a different search.</p>
      ) : (
        <div className="ots-search-list">
          {candidates.map((candidate) => {
            const isSelected = selectedByKey.has(candidate.targetKey);
            return (
              <div key={candidate.targetKey} className="ocb-card ots-search-row">
                <span className="ots-sel__who">
                  <span className="ots-sel__name">{candidate.displayName}</span>
                  <span className="ots-sel__line">
                    {[candidate.title, candidate.organization].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                  disabled={isSelected || busy}
                  onClick={() => void add(candidate)}
                >
                  {isSelected ? 'Added' : '+ Add'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * "Committee staff" tab. Committee staff has no `search_targets` source (see
 * capiro-outreach-v3-build skill notes — it would need a full capability
 * candidate-generation implementation for a source with no independent text
 * search of its own). The two-step committee→roster pattern is exactly what
 * the standalone Directory > Committee Staff page already does
 * (`useCommitteeStaffModel.ts`); this reuses the same two endpoints directly
 * rather than pulling in that hook's URL-as-state / hierarchy machinery,
 * which belongs to that page, not this campaign-builder step.
 */
function CommitteeStaffPanel({
  selected,
  busy,
  applyCommands,
}: {
  selected: OutreachV3ResolvedTargetRef[];
  busy: boolean;
  applyCommands: (commands: ReturnType<typeof addTargetCommand>[]) => Promise<unknown>;
}): JSX.Element {
  const api = useApi();
  const [committeeId, setCommitteeId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const committees = useQuery({
    queryKey: ['outreach-v3', 'committees'],
    queryFn: async () =>
      (await api.get<DirectoryCommitteesResponse>('/api/directory/committees', {
        params: { page: 1, pageSize: 200 },
      })).data,
    staleTime: 10 * 60_000,
  });

  const effectiveCommitteeId = committeeId || committees.data?.committees[0]?.id || '';

  const staff = useQuery({
    queryKey: ['outreach-v3', 'committee-staff', effectiveCommitteeId],
    queryFn: async () =>
      (
        await api.get<DirectoryCommitteeStaffResponse>(
          `/api/directory/committees/${encodeURIComponent(effectiveCommitteeId)}/staff`,
          { params: { pageSize: 500 } },
        )
      ).data,
    enabled: Boolean(effectiveCommitteeId),
    staleTime: 5 * 60_000,
  });

  const selectedByKey = useMemo(() => {
    const map = new Map<string, OutreachV3ResolvedTargetRef>();
    for (const target of selected) map.set(target.targetKey, target);
    return map;
  }, [selected]);

  const add = async (staffer: DirectoryCommitteeStaffer) => {
    setError(null);
    const locator: OutreachV3TargetLocator = { source: 'committee_staff', id: staffer.id };
    try {
      await applyCommands([addTargetCommand(locator)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const roster = staff.data?.staff ?? [];

  return (
    <div className="ocb-stack">
      <div className="ocb-field">
        <span className="ocb-field__label">Committee</span>
        <select
          className="ocb-input"
          value={effectiveCommitteeId}
          onChange={(event) => setCommitteeId(event.target.value)}
        >
          {(committees.data?.committees ?? []).map((committee: DirectoryCommittee) => (
            <option key={committee.id} value={committee.id}>
              {committee.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className="ocb-note ocb-note--warn" role="alert">
          {error}
        </p>
      ) : null}
      {staff.isLoading ? (
        <p className="ocb-empty">Loading committee staff…</p>
      ) : staff.isError ? (
        <p className="ocb-empty" role="alert">
          {safeOutreachV3Error(staff.error)}
        </p>
      ) : roster.length === 0 ? (
        <p className="ocb-empty">No staff on file for this committee.</p>
      ) : (
        <div className="ots-search-list">
          {roster.map((staffer) => {
            // A committee_staff locator's targetKey is derived server-side
            // from `${source}:${id}` exactly like every other source (see
            // targetKeyForLocator in outreach-target.contract.ts) — computed
            // the same way here rather than re-adding just to find out.
            const targetKey = `committee_staff:${staffer.id}`;
            const isSelected = selectedByKey.has(targetKey);
            return (
              <div key={staffer.id} className="ocb-card ots-search-row">
                <span className="ots-sel__who">
                  <span className="ots-sel__name">{staffer.fullName}</span>
                  <span className="ots-sel__line">{[staffer.title, staffer.committee.name].filter(Boolean).join(' · ')}</span>
                </span>
                {staffer.isCurrent ? null : <span className="ots-warnpill">Former staff</span>}
                <button
                  type="button"
                  className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                  disabled={isSelected || busy}
                  onClick={() => void add(staffer)}
                >
                  {isSelected ? 'Added' : '+ Add'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Per-target Cc/Bcc popover for the Selected tab. A deliberately scoped-down
 * port of V2's `NewOutreachWizard.tsx` `CcBccPopover` — manual, comma/line
 * separated email entry only, no Directory/Client/Team contact search and no
 * bulk/list/group apply modes. Those V2 features operate over a whole
 * selection at once; V3's Cc/Bcc is stored per-target
 * (`spec.targeting.targetCcBcc[targetKey]`), and this campaign builder's
 * Targets step has no bulk-selection concept to apply them to. A working
 * per-target manual popover covers the actual requirement without inventing
 * selection machinery this step doesn't have.
 */
function CcBccButton({
  target,
  current,
  busy,
  applyCommands,
}: {
  target: OutreachV3ResolvedTargetRef;
  current: { cc: string[]; bcc: string[] };
  busy: boolean;
  applyCommands: (commands: ReturnType<typeof setTargetCcBccCommand>[]) => Promise<unknown>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [cc, setCc] = useState(current.cc.join(', '));
  const [bcc, setBcc] = useState(current.bcc.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const parseList = (value: string): string[] =>
    value
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const submit = async () => {
    const ccList = parseList(cc);
    const bccList = parseList(bcc);
    const invalid = [...ccList, ...bccList].find((address) => !EMAIL_RE.test(address));
    if (invalid) {
      setError(`"${invalid}" is not a valid email address.`);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await applyCommands([
        setTargetCcBccCommand(target.targetKey, { cc: ccList, bcc: bccList }),
      ]);
      setOpen(false);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    } finally {
      setPending(false);
    }
  };

  const count = current.cc.length + current.bcc.length;

  return (
    <span className="ots-ccbcc">
      <button
        type="button"
        className="ocb-btn ocb-btn--secondary ocb-btn--xs"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <Mail size={13} aria-hidden="true" />
        {count > 0 ? `Cc/Bcc · ${count}` : 'Cc/Bcc'}
      </button>
      {open ? (
        <div className="ocb-card ots-ccbcc__pop" role="dialog" aria-label={`Cc/Bcc for ${target.displayName}`}>
          <div className="ocb-field">
            <span className="ocb-field__label">Cc</span>
            <textarea
              className="ocb-input"
              rows={2}
              placeholder="name@example.com, name2@example.com"
              value={cc}
              onChange={(event) => setCc(event.target.value)}
            />
          </div>
          <div className="ocb-field">
            <span className="ocb-field__label">Bcc</span>
            <textarea
              className="ocb-input"
              rows={2}
              placeholder="name@example.com, name2@example.com"
              value={bcc}
              onChange={(event) => setBcc(event.target.value)}
            />
          </div>
          {error ? (
            <p className="ocb-note ocb-note--warn" role="alert">
              {error}
            </p>
          ) : null}
          <div className="ocb-row">
            <button
              type="button"
              className="ocb-btn ocb-btn--primary ocb-btn--sm"
              disabled={pending || busy}
              onClick={() => void submit()}
            >
              {pending ? <Loader2 size={14} className="ots-spin" aria-hidden="true" /> : null}
              Save
            </button>
            <button
              type="button"
              className="ocb-btn ocb-btn--secondary ocb-btn--sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

export function OutreachTargetsStep(props: OutreachTargetsStepProps): JSX.Element {
  const { session, sessionId, busy, applyCommands, toast, onNext, primaryLabel } = props;
  const api = useApi();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<OutreachTargetsTab>('Directory');
  const [builderKind, setBuilderKind] = useState<OutreachAudienceKind | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [newAudienceId, setNewAudienceId] = useState<string | null>(null);
  const [profileLocator, setProfileLocator] = useState<OutreachV3TargetLocator | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = outreachSelectedTargets(session);
  const nSel = selected.length;
  const emailableTargets = useMemo(() => selected.filter(audienceEmailable), [selected]);
  const emailless = nSel - emailableTargets.length;
  // Office-level dedupe advisory. Only for one-email-each delivery: a shared
  // thread is a single email the whole office can see, so same-office members
  // there are the point, not a hazard.
  const sameOfficeWarning = useMemo(() => {
    if (session?.spec.delivery?.pattern === 'shared_thread') return null;
    return outreachSameOfficeWarning(outreachSameOfficeGroups(selected));
  }, [selected, session?.spec.delivery?.pattern]);

  const audiences = useQuery({
    queryKey: AUDIENCES_QUERY_KEY,
    queryFn: () => listSavedOutreachAudiences(api),
    // Only the Saved tab reads them; the Directory is the first paint and must
    // not pay for a request nobody is looking at.
    enabled: tab === 'Saved audiences',
  });

  /**
   * Every address already on the campaign, lower-cased. Membership by email is
   * what makes "Saved" honest: a saved member's locator source is a
   * re-resolution hint ('congress'), never the stored ref's own source, so
   * comparing locators would report "not applied" for audiences that are.
   */
  const selectedEmails = useMemo(() => {
    const set = new Set<string>();
    for (const target of selected) {
      const email = target.email?.trim().toLowerCase();
      if (email) set.add(email);
    }
    return set;
  }, [selected]);

  /**
   * List means one email each, group means one shared email. `deliveryCommands`
   * refuses `shared_thread` + `high` outright, so a group takes 'light' — the
   * server's readiness check reports the same incompatibility as a blocker.
   */
  const deliveryFor = (kind: OutreachAudienceKind) =>
    kind === 'group'
      ? deliveryCommands('shared_thread', 'light')
      : deliveryCommands('personalized_separate', 'high');

  const startBuild = (kind: OutreachAudienceKind) => {
    setBuilderKind(kind);
    setTab('Directory');
    setSaveOpen(false);
    setSaveName('');
    setError(null);
  };

  const cancelBuild = () => {
    setBuilderKind(null);
    setSaveOpen(false);
  };

  const save = useMutation({
    mutationFn: async (input: { kind: OutreachAudienceKind; name: string }) => {
      // Delivery first, audience second. Saving a group is the user stating
      // that this campaign goes out as one shared email, so both writes belong
      // to the gesture — but only one of them is idempotent. Re-applying the
      // same delivery pair reports `no_change`, while creating the audience
      // twice leaves a duplicate in the firm library that nothing cleans up.
      // In this order a failure leaves either nothing, or a delivery pattern
      // the user just asserted, and the retry is clean.
      await applyCommands(deliveryFor(input.kind));
      return createSavedOutreachAudience(api, {
        kind: input.kind,
        name: input.name,
        members: emailableTargets.map(targetToAudienceMemberInput),
      });
    },
    onSuccess: (created, input) => {
      void queryClient.invalidateQueries({ queryKey: AUDIENCES_QUERY_KEY });
      setNewAudienceId(created.id);
      setBuilderKind(null);
      setSaveOpen(false);
      setSaveName('');
      setError(null);
      toast(
        `${input.kind === 'group' ? 'Group saved' : 'List saved'} · ${input.name} — ${contactCount(
          created.members.length,
        )}`,
      );
    },
    onError: (caught) => setError(safeOutreachV3Error(caught)),
  });

  const apply = useMutation({
    mutationFn: async (audience: SavedAudience) => {
      await applyCommands([
        ...audience.members.map((member) => addTargetCommand(savedMemberLocator(member))),
        ...deliveryFor(audience.kind),
      ]);
      return audience;
    },
    onSuccess: (audience) => {
      setError(null);
      toast(`${audience.name} added · ${contactCount(audience.members.length)}`);
    },
    onError: (caught) => setError(safeOutreachV3Error(caught)),
  });

  const removeTarget = async (targetKey: string) => {
    setError(null);
    try {
      await applyCommands([removeTargetCommand(targetKey)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const profile = useQuery({
    queryKey: ['outreach-v3', 'target-profile', sessionId, profileLocator],
    queryFn: () => getOutreachV3TargetProfile(api, sessionId, profileLocator as OutreachV3TargetLocator),
    enabled: Boolean(profileLocator),
  });

  // The relationship read is client-scoped by contract, so it only runs when
  // the workspace has a client in context.
  const relationship = useQuery({
    queryKey: [
      'outreach-v3',
      'target-relationships',
      sessionId,
      profileLocator,
      props.selectedClientId,
    ],
    queryFn: () =>
      getOutreachV3TargetRelationships(
        api,
        sessionId,
        profileLocator as OutreachV3TargetLocator,
        props.selectedClientId as string,
      ),
    enabled: Boolean(profileLocator) && Boolean(props.selectedClientId),
  });

  const tabs: Array<{ id: OutreachTargetsTab; label: string }> = [
    { id: 'Directory', label: 'Directory' },
    { id: 'State legislators', label: 'State legislators' },
    { id: 'Committee staff', label: 'Committee staff' },
    { id: 'Add manually', label: 'Add manually' },
    { id: 'Saved audiences', label: 'Saved audiences' },
    { id: 'Selected', label: `Selected · ${nSel}` },
  ];

  const saveBlocked = emailableTargets.length === 0;
  const profileData = profile.data?.data ?? null;
  const relationshipData = relationship.data?.data ?? null;

  return (
    <div className="ocb-step ots">
      <div className="ots-tabs">
        <div className="ots-tabs__group" role="tablist" aria-label="Targets">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`ots-tab-${entry.id.replace(/\s+/g, '-')}`}
              aria-selected={tab === entry.id}
              aria-controls="ots-panel"
              className="ocb-tab"
              data-active={tab === entry.id ? 'true' : undefined}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="ots-tabs__spacer" />
        <button
          type="button"
          className="ocb-btn ocb-btn--sm ots-new ots-new--list"
          onClick={() => startBuild('list')}
        >
          <Plus size={15} aria-hidden="true" />
          New list
        </button>
        <button
          type="button"
          className="ocb-btn ocb-btn--sm ots-new ots-new--group"
          onClick={() => startBuild('group')}
        >
          <Users size={15} aria-hidden="true" />
          New group
        </button>
      </div>

      <p className="ocb-prose ots-explainer">
        A <strong>list</strong> sends each member their own 1:1 email. A <strong>group</strong> sends
        one shared email to everyone on it. Both are saved to your firm’s contact library and
        reusable across campaigns.
      </p>

      {builderKind ? (
        <div className="ots-build" data-kind={builderKind}>
          <span className="ots-build__text">
            <span className="ots-build__count">
              {nSel === 1 ? '1 member selected' : `${nSel} members selected`}
            </span>
            <span className="ots-build__sub">
              {builderKind === 'group'
                ? 'These recipients will be emailed as a group — one email sent together, not individually.'
                : 'Each recipient gets their own 1:1 email. Nobody sees the rest of the list.'}
            </span>
          </span>
          <button
            type="button"
            className="ocb-btn ocb-btn--primary ocb-btn--sm"
            /* The prototype gates this on member count alone and leaves the
               email check to the save dialog, so the "none of the selected
               contacts have a usable email address" warning stays reachable. */
            disabled={nSel === 0 || busy || save.isPending}
            onClick={() => {
              setSaveOpen(true);
              setSaveName('');
            }}
          >
            {builderKind === 'group' ? 'Save as group' : 'Save as list'}
          </button>
          <button
            type="button"
            className="ocb-btn ocb-btn--secondary ocb-btn--sm"
            onClick={cancelBuild}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {builderKind && saveOpen ? (
        <div className="ocb-card ots-save">
          <h3 className="ots-save__title">
            {builderKind === 'group' ? 'Save as group' : 'Save as list'}
          </h3>
          <p className="ocb-prose ots-save__lead">
            {builderKind === 'group'
              ? 'This will save your selected recipients as a reusable group. They will always be emailed together on one shared email.'
              : 'This will save your selected recipients as a reusable list. Each one gets their own 1:1 email whenever the list is used.'}
          </p>
          <label className="ocb-field ots-save__field">
            <span className="ocb-field__label">
              {builderKind === 'group' ? 'Group name' : 'List name'}
            </span>
            <input
              className="ocb-input"
              value={saveName}
              maxLength={120}
              placeholder={builderKind === 'group' ? 'HASC Member Offices' : 'HASC autonomy staff'}
              onChange={(event) => setSaveName(event.target.value)}
            />
          </label>
          {emailless > 0 ? (
            <p className="ocb-note ocb-note--warn">
              {saveBlocked
                ? 'None of the selected contacts have a usable email address — add at least one with an email before saving.'
                : `${emailless === 1 ? '1 contact' : `${emailless} contacts`} without a usable email address will be left out.`}
            </p>
          ) : null}
          <p className="ocb-note ocb-note--muted">
            Saved to your firm’s contact library and reusable across campaigns.
          </p>
          <div className="ocb-row">
            <button
              type="button"
              className="ocb-btn ocb-btn--primary ocb-btn--sm"
              disabled={!saveName.trim() || saveBlocked || save.isPending || busy}
              onClick={() => {
                void save
                  .mutateAsync({ kind: builderKind, name: saveName.trim() })
                  .catch(() => undefined);
              }}
            >
              {save.isPending ? <Loader2 size={14} className="ots-spin" aria-hidden="true" /> : null}
              {builderKind === 'group' ? 'Save as group' : 'Save as list'}
            </button>
            <button
              type="button"
              className="ocb-btn ocb-btn--secondary ocb-btn--sm"
              onClick={() => setSaveOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="ocb-note ocb-note--warn ots-error" role="alert">
          {error}
        </p>
      ) : null}

      {profileLocator ? (
        <div className="ocb-card ots-profile">
          <div className="ots-profile__head">
            <span className="ocb-eyebrow">Target profile</span>
            <button
              type="button"
              className="ocb-btn ocb-btn--secondary ocb-btn--xs"
              onClick={() => setProfileLocator(null)}
            >
              <X size={14} aria-hidden="true" />
              Close
            </button>
          </div>
          {profile.isLoading ? (
            <p className="ocb-note">Loading this profile…</p>
          ) : profile.isError ? (
            <p className="ocb-note ocb-note--warn">{safeOutreachV3Error(profile.error)}</p>
          ) : profileData ? (
            <div className="ocb-kv">
              <div className="ocb-kv__row">
                <span className="ocb-kv__key">Name</span>
                <span className="ocb-kv__value">{profileData.identity.displayName}</span>
              </div>
              <div className="ocb-kv__row">
                <span className="ocb-kv__key">Role</span>
                <span className="ocb-kv__value">
                  {[profileData.role.title, profileData.role.organization]
                    .filter(Boolean)
                    .join(' · ') || 'Not recorded'}
                </span>
              </div>
              <div className="ocb-kv__row">
                <span className="ocb-kv__key">Email</span>
                <span
                  className="ocb-kv__value"
                  data-unset={profileData.contact.email ? undefined : 'true'}
                >
                  {profileData.contact.email ?? 'No email on file'}
                </span>
              </div>
              {relationshipData ? (
                <div className="ocb-kv__row">
                  <span className="ocb-kv__key">Relationship</span>
                  <span className="ocb-kv__value">
                    {relationshipData.status} ·{' '}
                    {relationshipData.interactionCount === 1
                      ? '1 interaction'
                      : `${relationshipData.interactionCount} interactions`}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        id="ots-panel"
        role="tabpanel"
        aria-labelledby={`ots-tab-${tab.replace(/\s+/g, '-')}`}
        className="ots-body"
      >
        {tab === 'Directory' ? (
          <TargetDirectoryBrowser
            selected={selected}
            busy={busy}
            applyCommands={applyCommands}
            onProfile={setProfileLocator}
          />
        ) : null}

        {tab === 'State legislators' ? (
          <StateLegislatorsPanel
            sessionId={sessionId}
            selected={selected}
            busy={busy}
            applyCommands={applyCommands}
          />
        ) : null}

        {tab === 'Committee staff' ? (
          <CommitteeStaffPanel selected={selected} busy={busy} applyCommands={applyCommands} />
        ) : null}

        {tab === 'Add manually' ? (
          <AddManuallyPanel busy={busy} applyCommands={applyCommands} />
        ) : null}

        {tab === 'Saved audiences' ? (
          audiences.isLoading ? (
            <p className="ocb-empty">Loading your saved lists and groups…</p>
          ) : audiences.isError ? (
            <p className="ocb-empty" role="alert">
              {safeOutreachV3Error(audiences.error)}
            </p>
          ) : (audiences.data?.length ?? 0) === 0 ? (
            <p className="ocb-empty">
              No saved lists or groups yet. Choose your recipients, then use New list or New group to
              save them.
            </p>
          ) : (
            <div className="ots-saved">
              {(audiences.data ?? []).map((audience) => {
                const count = audience.members.length;
                const isApplied =
                  count > 0 &&
                  audience.members.every((member) =>
                    selectedEmails.has(member.email.trim().toLowerCase()),
                  );
                return (
                  <div key={audience.id} className="ocb-card ots-aud">
                    <div className="ots-aud__head">
                      <span className="ots-aud__kind" data-kind={audience.kind}>
                        {audience.kind === 'group' ? 'Group' : 'List'}
                      </span>
                      {audience.id === newAudienceId ? (
                        <span className="ots-aud__new">New</span>
                      ) : null}
                    </div>
                    <span className="ots-aud__name">{audience.name}</span>
                    <span className="ots-aud__meta">
                      {`${contactCount(count)} · ${
                        audience.kind === 'group' ? 'one shared email' : '1:1 emails'
                      }`}
                    </span>
                    <button
                      type="button"
                      className="ocb-btn ocb-btn--secondary ocb-btn--xs ots-aud__act"
                      data-applied={isApplied ? 'true' : undefined}
                      disabled={isApplied || count === 0 || busy || apply.isPending}
                      onClick={() => {
                        void apply.mutateAsync(audience).catch(() => undefined);
                      }}
                    >
                      {isApplied ? 'Saved' : '+ Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : null}

        {tab === 'Selected' ? (
          <div className="ocb-card ots-sel">
            <div className="ots-sel__bar">
              <span className="ocb-eyebrow">
                {nSel === 1 ? '1 target selected' : `${nSel} targets selected`}
              </span>
            </div>
            {sameOfficeWarning ? (
              <p className="ocb-note ocb-note--warn ots-sel__office-warn" role="status">
                {sameOfficeWarning}
              </p>
            ) : null}
            {nSel === 0 ? (
              <p className="ocb-empty">
                No targets yet. Add members or staffers from the Directory.
              </p>
            ) : (
              selected.map((target) => (
                <div key={target.targetKey} className="ots-sel__row">
                  <span className="ots-sel__who">
                    <span className="ots-sel__name">{target.displayName}</span>
                    <span className="ots-sel__line">{targetSubline(target)}</span>
                  </span>
                  {outreachTargetIsSendable(target) ? null : (
                    <span className="ots-warnpill">No email on file</span>
                  )}
                  <span className="ots-sel__kind">{targetKindLabel(target)}</span>
                  <CcBccButton
                    target={target}
                    current={
                      session?.spec.targeting.targetCcBcc?.[target.targetKey] ?? { cc: [], bcc: [] }
                    }
                    busy={busy}
                    applyCommands={applyCommands}
                  />
                  <button
                    type="button"
                    className="ocb-btn ocb-btn--secondary ocb-btn--xs"
                    disabled={busy}
                    onClick={() => void removeTarget(target.targetKey)}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      {/* The prototype gates nothing here — Continue is live with zero targets,
          with an unsaved builder open, and with no emailable recipient. The Send
          step is where a missing address actually blocks. */}
      <button
        type="button"
        className="ocb-btn ocb-btn--primary ots-next"
        disabled={busy}
        onClick={onNext}
      >
        {primaryLabel}
      </button>
    </div>
  );
}
