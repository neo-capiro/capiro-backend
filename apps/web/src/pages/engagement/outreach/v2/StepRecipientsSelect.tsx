// Step 3, Recipients — "Select recipients".
//
// One mixable pool of targets per the frozen design doc:
//   • Individual — one 1:1 email (added via + from any source tab)
//   • List — campaign-local saved set; every member gets their OWN email
//   • Group — campaign-local set sharing ONE email
// Sources: Congressional Directory (GET /api/directory/contacts, staffers
// nested per member), Client Contacts (clients prop + GET
// /api/clients/:id/people — the doc's derived Client Directory view), and
// Manual Add. Favorites reuse the existing directory favorites API
// (GET /api/directory/favorites, POST/DELETE /contacts/:id/favorite).
//
// + always adds straight to To; Cc/Bcc are managed afterwards in the
// selected-recipients panel (per individual / per list member / per group)
// and via the campaign-global Cc/Bcc bar. Lists/Groups are created from a
// build mode (checkboxes) entered from the toolbar dropdowns; they live on
// the campaign until the OutreachAudience persistence lands.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Badge, Button, Checkbox, Dropdown, Input, Modal, Select } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  DownOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useApi } from '../../../../lib/use-api.js';
import type { Client, ClientPerson } from '../../../clients/clientTypes.js';
import type { DirectoryApiResponse, DirectoryEntry } from '../../../directory/directoryData.js';
import type { OutreachRecipient } from '../../OutreachView.js';
import { recipientKey } from './types.js';
import {
  EMAIL_RE,
  individualTarget,
  membershipOf,
  newTargetKey,
  totalRecipients,
  type CcBccContact,
  type OutreachTarget,
  type TargetType,
} from './targets.js';
import {
  apiErrorMessage,
  audienceMemberToRecipient,
  plural,
  toAudienceMemberInput,
  type AudienceBuilderState,
  type AudienceRow,
} from './audiences.js';
import { useGroups } from './groups.js';
import { candidateEmails, formatLastContacted, usePriorContact } from './priorContact.js';
import './step-recipients-select.css';

/**
 * "Last contacted Nd ago" badge (W5.2). Provided once at the top of the Recipients
 * step; each selected-recipient row consumes it via context, so the badge lands in
 * every row type without drilling a prop through SelectedPanel/ListEntity/GroupEntity.
 * Default renders nothing (feature-absent / no prior contact).
 */
const LastContactContext = createContext<(email?: string | null) => ReactNode>(() => null);

interface Props {
  clients: Client[];
  targets: OutreachTarget[];
  onChange: (patch: { targets?: OutreachTarget[] }) => void;
  /** Campaign client (scopes the "last contacted" lookup); optional. */
  clientId?: string | null;
}

type SourceTab = 'congress' | 'statelegislators' | 'clients' | 'manual';

interface FavoriteRow {
  directoryContactId: string;
  directoryContactName: string | null;
}

// ---- source row → OutreachRecipient converters (same field mapping the
// previous StepRecipients used, kept here so that file stays untouched) ----

function fromDirectoryEntry(entry: DirectoryEntry): OutreachRecipient {
  const address = entry.addresses.find((a) => a.isMain) ?? entry.addresses[0];
  const formattedAddress = address
    ? [address.address1, address.city, address.state, address.zip].filter(Boolean).join(', ')
    : entry.officeLocation;
  return {
    name: entry.fullName,
    email: entry.email || undefined,
    office: entry.office || undefined,
    title: entry.title || undefined,
    chamber: entry.chamber || undefined,
    state: entry.state || undefined,
    district: entry.district || undefined,
    party: entry.partyName || undefined,
    directoryContactId: entry.id,
    directoryContactName: entry.fullName,
    committee: entry.committees[0] || undefined,
    address: formattedAddress || undefined,
    relevanceReason: [entry.committees[0], entry.focusAreas[0]].filter(Boolean).join(' | '),
  };
}

function stafferRecipient(
  entry: DirectoryEntry,
  staffer: DirectoryEntry['staff'][number],
): OutreachRecipient {
  return {
    name: staffer.fullName,
    email: staffer.email || undefined,
    office: entry.office || undefined,
    title: staffer.title || undefined,
    chamber: entry.chamber || undefined,
    state: entry.state || undefined,
    district: entry.district || undefined,
    party: entry.partyName || undefined,
    directoryContactId: `${entry.id}:${staffer.id}`,
    directoryContactName: `${staffer.fullName} (${entry.memberName})`,
    committee: entry.committees[0] || undefined,
    relevanceReason: `Staffer to ${entry.fullName}${staffer.title ? `, ${staffer.title}` : ''}`,
  };
}

// ---- State Legislators source (GET /api/explorer/state-legislators) --------
// Mirrors the explorer.service.ts response shape; `committees` is present only
// when the tab requests includeCommittees=true.

interface StateLegislatorCommitteeRef {
  id: string;
  name: string;
  chamber: string | null;
  role: string | null;
}

interface StateLegislatorRow {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  district: string | null;
  party: string | null;
  email: string | null;
  image: string | null;
  url: string | null;
  committees?: StateLegislatorCommitteeRef[];
}

interface StateLegislatorListResponse {
  rows: StateLegislatorRow[];
  total: number;
}

interface StateLegislatorFacetsResponse {
  states: string[];
  chambers: string[];
  parties: string[];
  // Scoped to the queried state(s); empty when no state is requested.
  committees: string[];
}

// OpenStates stores chamber as 'upper' | 'lower'. Map to the familiar names for
// display; fall back to whatever raw value came through (a few bodies aren't
// upper/lower) and never invent one.
function humanizeStateChamber(chamber: string | null | undefined): string {
  if (chamber === 'upper') return 'Senate';
  if (chamber === 'lower') return 'House';
  return chamber || '';
}

function stateLegislatorRole(chamber: string | null | undefined): string {
  const c = humanizeStateChamber(chamber);
  if (c === 'Senate') return 'State Senator';
  if (c === 'House') return 'State Representative';
  return c ? `State ${c}` : 'State Legislator';
}

/** "State Senator · District 5" sub-line for a legislator row. */
function stateLegislatorSubline(row: StateLegislatorRow): string {
  const dist = row.district ? `District ${row.district}` : null;
  return [stateLegislatorRole(row.chamber), dist].filter(Boolean).join(' · ');
}

function fromStateLegislator(row: StateLegislatorRow): OutreachRecipient {
  const chamberLabel = humanizeStateChamber(row.chamber);
  const first = row.committees?.[0];
  return {
    // Namespaced id → recipientKey resolves to this (id wins the fallback
    // chain), so a legislator can never collide with a congressional-directory
    // contact id and get silently deduped away.
    id: `statelegislator:${row.id}`,
    name: row.name,
    email: row.email || undefined,
    title: stateLegislatorRole(row.chamber),
    office: chamberLabel ? `${row.state} ${chamberLabel}` : row.state || undefined,
    chamber: chamberLabel || undefined,
    state: row.state || undefined,
    district: row.district || undefined,
    party: row.party || undefined,
    committee: first?.name || undefined,
    directoryContactName: row.name,
    sourceLabel: 'State Legislature',
    relevanceReason: [
      first && (first.role ? `${first.name} (${first.role})` : first.name),
      row.party || undefined,
    ]
      .filter(Boolean)
      .join(' | '),
  };
}

function clientPersonRecipient(client: Client, person: ClientPerson): OutreachRecipient {
  return {
    id: `clientperson:${person.id}`,
    clientId: client.id,
    name: person.name,
    email: person.email || undefined,
    title: person.title || undefined,
    sourceLabel: client.name,
    relevanceReason: person.role ? `${person.role} — ${client.name}` : `Contact at ${client.name}`,
  };
}

function clientIndustry(client: Client): string {
  return (
    client.sectorTag || client.intakeData?.sectors?.[0] || client.intakeData?.sector || 'Client'
  );
}

// Per the boards: list members read as direct sends, so they tag "In To"
// like individuals; only group membership gets its own (amber) tag.
const MEMBERSHIP_TAG: Record<TargetType, { text: string; cls: string }> = {
  individual: { text: 'In To', cls: 'to' },
  list: { text: 'In To', cls: 'to' },
  group: { text: 'In Group', cls: 'group' },
};

// =====================================================================
// Main step
// =====================================================================

export function StepRecipientsSelect({ clients, targets, onChange, clientId }: Props) {
  const api = useApi();
  const qc = useQueryClient();
  const { message, notification } = App.useApp();
  // "Last contacted" badge data for the currently-selected recipients (W5.2).
  const priorEmails = useMemo(() => candidateEmails(targets), [targets]);
  const { byEmail: priorContact } = usePriorContact(api, priorEmails, clientId ?? null);
  const renderLastContact = useCallback(
    (email?: string | null): ReactNode => {
      const pc = email ? priorContact.get(email.trim().toLowerCase()) : undefined;
      if (!pc) return null;
      return (
        <span className="ov2-rs-lastcontact" title={pc.subject ? `re: "${pc.subject}"` : undefined}>
          {formatLastContacted(pc.sentAt)}
        </span>
      );
    },
    [priorContact],
  );
  const [tab, setTab] = useState<SourceTab>('congress');
  const [builder, setBuilder] = useState<AudienceBuilderState | null>(null);
  const [saveListOpen, setSaveListOpen] = useState(false);
  const [saveListName, setSaveListName] = useState('');
  // Controlled because clicks inside custom dropdownRender content don't
  // auto-close an antd Dropdown — it must be dismissed when an action is
  // taken so it doesn't float over the build banner / applied chips.
  const [listsOpen, setListsOpen] = useState(false);
  const total = totalRecipients(targets);

  const setTargets = (next: OutreachTarget[]) => onChange({ targets: next });

  // Groups (boards 7 & 8) — saved/reusable amber audiences, kind:'group'.
  // The hook owns the saved-groups query, the save mutation, and the three
  // rendered pieces below; the build-mode selection is shared with Lists.
  const { groupsPopover, groupBuildBanner, saveGroupModal, groupsOpen, setGroupsOpen } = useGroups({
    targets,
    setTargets,
    builder,
    setBuilder,
  });

  const addIndividual = (r: OutreachRecipient) => {
    // Only blocked if already an individual / list member — being in a group
    // does NOT prevent adding someone as an individual (groups are orthogonal).
    if (membershipOf(targets, recipientKey(r), 'personal')) return;
    setTargets([...targets, individualTarget(r)]);
  };

  const removeIndividualByKey = (key: string) => {
    setTargets(
      targets.filter(
        (t) => !(t.type === 'individual' && t.recipients.some((r) => recipientKey(r) === key)),
      ),
    );
  };

  // Checkbox click while building a list/group: toggle membership in the
  // in-progress selection. (+ keeps adding straight to To during build mode.)
  const builderToggle = (r: OutreachRecipient) => {
    if (!builder) return;
    const key = recipientKey(r);
    setBuilder({
      ...builder,
      members: builder.members.some((m) => recipientKey(m) === key)
        ? builder.members.filter((m) => recipientKey(m) !== key)
        : [...builder.members, r],
    });
  };

  // Manual Add routes here. An explicit "Add" button must never act as a
  // toggle — re-submitting an email already in the selection replaces that
  // entry (picking up e.g. a corrected name) instead of silently removing it.
  const pickPerson = (r: OutreachRecipient) => {
    if (builder) {
      const key = recipientKey(r);
      if (builder.members.some((m) => recipientKey(m) === key)) {
        setBuilder({
          ...builder,
          members: builder.members.map((m) => (recipientKey(m) === key ? r : m)),
        });
        message.info('Already in your selection — entry updated.');
        return;
      }
      builderToggle(r);
      return;
    }
    addIndividual(r);
  };

  const builderHas = (key: string) =>
    !!builder && builder.members.some((m) => recipientKey(m) === key);

  // ---- saved lists (user-level contact library) ----
  const audiences = useQuery<AudienceRow[]>({
    queryKey: ['outreach-audiences', 'list'],
    queryFn: async () =>
      (
        await api.get<AudienceRow[]>('/api/engagement/outreach/audiences', {
          params: { kind: 'list' },
        })
      ).data,
  });

  // Apply a saved list to the campaign as a List target. People already in
  // the campaign are skipped (a person in two targets would silently lose
  // their list cc/bcc in the flattened projection — first occurrence wins).
  const applyAudience = (audience: AudienceRow, currentTargets: OutreachTarget[]) => {
    const incoming = audience.members.map(audienceMemberToRecipient);
    // Skip only people already in the personal "To" (an individual or another
    // list); group members are still free to join a list.
    const fresh = incoming.filter(
      (r) => !membershipOf(currentTargets, recipientKey(r), 'personal'),
    );
    const skipped = incoming.length - fresh.length;
    if (fresh.length === 0) {
      message.info('Everyone in this list is already in the campaign.');
      return;
    }
    setTargets([
      ...currentTargets,
      {
        key: newTargetKey(),
        type: 'list',
        audienceId: audience.id,
        name: audience.name,
        recipients: fresh,
        cc: [],
        bcc: [],
        memberCc: {},
        memberBcc: {},
      },
    ]);
    setListsOpen(false);
    if (skipped > 0) {
      message.info(
        `${skipped} ${skipped === 1 ? 'contact was' : 'contacts were'} already in the campaign and skipped.`,
      );
    }
  };

  // Save the build-mode selection to the user's contact library, then apply
  // it to this campaign (board 5d: saved lists land in the selected panel).
  // Members are pre-filtered with EMAIL_RE because the API validates every
  // member with @IsEmail and one bad address would 400 the whole save.
  const saveList = useMutation({
    mutationFn: async (vars: { name: string; members: OutreachRecipient[] }) => {
      const emailable = vars.members.filter((m) => m.email && EMAIL_RE.test(m.email));
      const res = await api.post<AudienceRow>('/api/engagement/outreach/audiences', {
        kind: 'list',
        name: vars.name,
        members: emailable.map(toAudienceMemberInput),
      });
      return { audience: res.data, skippedNoEmail: vars.members.length - emailable.length };
    },
    onSuccess: ({ audience, skippedNoEmail }) => {
      qc.invalidateQueries({ queryKey: ['outreach-audiences'] });
      notification.success({
        message: 'List saved',
        description: `${audience.name} — ${plural(audience.members.length, 'contact')}`,
        placement: 'topRight',
      });
      if (skippedNoEmail > 0) {
        message.warning(
          `${plural(skippedNoEmail, 'contact')} without a usable email address ${skippedNoEmail === 1 ? 'was' : 'were'} not saved.`,
        );
      }
      applyAudience(audience, targets);
      setBuilder(null);
      setSaveListOpen(false);
      setSaveListName('');
    },
    onError: (err) => message.error(apiErrorMessage(err) ?? 'Could not save the list'),
  });

  const listTargets = targets.filter((t) => t.type === 'list');

  // Only members with a sendable email can be persisted to a saved list (the
  // API requires + validates email on every member).
  const emailableCount = builder
    ? builder.members.filter((m) => m.email && EMAIL_RE.test(m.email)).length
    : 0;
  const unsavableCount = (builder?.members.length ?? 0) - emailableCount;

  // Build-mode banner, rendered under the active tab's toolbar. Lists get the
  // blue bar (board 5b); groups get the amber bar from useGroups (board 7b).
  const builderBanner: ReactNode =
    builder?.kind === 'list' ? (
      <div className="ov2-rs-buildbar">
        <span className="count">
          {builder.members.length} {builder.members.length === 1 ? 'member' : 'members'} selected
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="save"
          disabled={builder.members.length === 0}
          onClick={() => {
            setSaveListName('');
            setSaveListOpen(true);
          }}
        >
          Save selection as list
        </button>
        <button type="button" className="cancel" onClick={() => setBuilder(null)}>
          Cancel
        </button>
      </div>
    ) : (
      groupBuildBanner
    );

  // Lists popover (board 6a): create-new entry point + the user's saved
  // lists from their contact library, each applyable to this campaign.
  const listsPopover: ReactNode = (
    <div className="ov2-rs-lists-pop">
      <button
        type="button"
        className="create"
        onClick={() => {
          setBuilder({ kind: 'list', name: '', members: [] });
          setListsOpen(false);
        }}
      >
        <span className="plus">
          <PlusOutlined />
        </span>
        Create new list
      </button>
      <div className="sec">Saved lists</div>
      {audiences.isLoading ? (
        <div className="empty">Loading your lists…</div>
      ) : (audiences.data ?? []).length === 0 ? (
        <div className="empty">No saved lists yet</div>
      ) : (
        (audiences.data ?? []).map((audience) => {
          const applied = targets.some((t) => t.audienceId === audience.id);
          return (
            <div key={audience.id} className="row">
              <div className="info">
                <b>{audience.name}</b>
                <small>
                  {audience.members.length} {audience.members.length === 1 ? 'contact' : 'contacts'}
                </small>
              </div>
              <Button
                size="small"
                disabled={applied}
                onClick={() => applyAudience(audience, targets)}
              >
                {applied ? 'Added' : '+ Add'}
              </Button>
            </div>
          );
        })
      )}
    </div>
  );

  // Applied-list chips under the toolbar (board 5d).
  const appliedChips: ReactNode = listTargets.length ? (
    <div className="ov2-rs-chips-row">
      {listTargets.map((t) => (
        <span key={t.key} className="ov2-rs-applied-chip">
          <UnorderedListOutlined /> {t.name} ({t.recipients.length})
          <button
            type="button"
            onClick={() => setTargets(targets.filter((x) => x.key !== t.key))}
            aria-label={`Remove ${t.name ?? 'list'} from this campaign`}
          >
            <CloseOutlined />
          </button>
        </span>
      ))}
      <span className="meta">
        {total} {total === 1 ? 'recipient' : 'recipients'} selected
      </span>
    </div>
  ) : null;

  return (
    <div>
      <h2>
        Select recipients
        {total > 0 && (
          <Badge
            count={total}
            style={{ backgroundColor: 'var(--ov2-accent-ink)', marginLeft: 8 }}
          />
        )}
      </h2>
      <div className="ov2-pane-sub">
        Choose congressional offices, staffers, committee contacts, or clients to receive this
        campaign.
      </div>

      {targets.length > 0 && (
        <LastContactContext.Provider value={renderLastContact}>
          <SelectedPanel targets={targets} onTargets={setTargets} clients={clients} />
        </LastContactContext.Provider>
      )}

      <div className="ov2-rs-tabs">
        <button
          type="button"
          className={'ov2-rs-tab' + (tab === 'congress' ? ' active' : '')}
          onClick={() => setTab('congress')}
        >
          Congressional Directory
        </button>
        <button
          type="button"
          className={'ov2-rs-tab' + (tab === 'statelegislators' ? ' active' : '')}
          onClick={() => setTab('statelegislators')}
        >
          State Legislators
        </button>
        <button
          type="button"
          className={'ov2-rs-tab' + (tab === 'clients' ? ' active' : '')}
          onClick={() => setTab('clients')}
        >
          Client Contacts
        </button>
        <button
          type="button"
          className={'ov2-rs-tab' + (tab === 'manual' ? ' active' : '')}
          onClick={() => setTab('manual')}
        >
          Manual Add
        </button>
      </div>

      {tab === 'congress' && (
        <CongressTab
          targets={targets}
          builderKind={builder?.kind ?? null}
          builderHas={builderHas}
          onBuilderToggle={builderToggle}
          onAdd={addIndividual}
          onRemoveIndividual={removeIndividualByKey}
          listsPopover={listsPopover}
          listsOpen={listsOpen}
          onListsOpenChange={setListsOpen}
          groupsPopover={groupsPopover}
          groupsOpen={groupsOpen}
          onGroupsOpenChange={setGroupsOpen}
          builderBanner={builderBanner}
          appliedChips={appliedChips}
        />
      )}
      {tab === 'statelegislators' && (
        <StateLegislatorsTab
          targets={targets}
          builderKind={builder?.kind ?? null}
          builderHas={builderHas}
          onBuilderToggle={builderToggle}
          onAdd={addIndividual}
          onRemoveIndividual={removeIndividualByKey}
          listsPopover={listsPopover}
          listsOpen={listsOpen}
          onListsOpenChange={setListsOpen}
          groupsPopover={groupsPopover}
          groupsOpen={groupsOpen}
          onGroupsOpenChange={setGroupsOpen}
          builderBanner={builderBanner}
          appliedChips={appliedChips}
        />
      )}
      {tab === 'clients' && (
        <ClientsTab
          clients={clients}
          targets={targets}
          builderKind={builder?.kind ?? null}
          builderHas={builderHas}
          onBuilderToggle={builderToggle}
          onAdd={addIndividual}
          onRemoveIndividual={removeIndividualByKey}
          listsPopover={listsPopover}
          listsOpen={listsOpen}
          onListsOpenChange={setListsOpen}
          groupsPopover={groupsPopover}
          groupsOpen={groupsOpen}
          onGroupsOpenChange={setGroupsOpen}
          builderBanner={builderBanner}
          appliedChips={appliedChips}
        />
      )}
      {tab === 'manual' && (
        <ManualTab
          onAdd={pickPerson}
          builderKind={builder?.kind ?? null}
          builderBanner={builderBanner}
        />
      )}

      <Modal
        title="Save as contact list"
        open={saveListOpen}
        // No dismissal while the POST is in flight: the mutation would still
        // complete and apply the list to the campaign after a "cancel".
        closable={!saveList.isPending}
        maskClosable={!saveList.isPending}
        onCancel={() => !saveList.isPending && setSaveListOpen(false)}
        footer={[
          <Button key="cancel" disabled={saveList.isPending} onClick={() => setSaveListOpen(false)}>
            Cancel
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={saveList.isPending}
            disabled={!saveListName.trim() || emailableCount === 0}
            onClick={() =>
              builder && saveList.mutate({ name: saveListName.trim(), members: builder.members })
            }
          >
            Save list
          </Button>,
        ]}
      >
        <p style={{ marginTop: 8 }}>
          This will save your {plural(builder?.members.length ?? 0, 'selected recipient')} as a
          reusable list.
        </p>
        {unsavableCount > 0 && (
          <p style={{ marginTop: 0, fontSize: 12, color: 'var(--ov2-notable)' }}>
            {emailableCount === 0
              ? 'None of the selected contacts have a usable email address — add at least one with an email before saving.'
              : `${plural(unsavableCount, 'contact')} without a usable email address will be left out.`}
          </p>
        )}
        <Input
          autoFocus
          placeholder="e.g. HASC staffers Q3"
          value={saveListName}
          onChange={(e) => setSaveListName(e.target.value)}
          onPressEnter={() => {
            if (saveListName.trim() && builder && emailableCount > 0 && !saveList.isPending) {
              saveList.mutate({ name: saveListName.trim(), members: builder.members });
            }
          }}
        />
        <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, color: 'var(--ov2-ink-3)' }}>
          Lists are saved to your individual contact library and can be reused across campaigns.
        </p>
      </Modal>

      {saveGroupModal}
    </div>
  );
}

// =====================================================================
// Cc/Bcc contact popover (shared by individual rows + bulk mode)
// =====================================================================

/** Two-letter initials for the result/tray avatar. */
function contactInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Merge new Cc/Bcc contacts into an existing list, deduped by email. */
function mergeContacts(
  existing: CcBccContact[] | undefined,
  incoming: CcBccContact[],
): CcBccContact[] {
  const out = [...(existing ?? [])];
  const seen = new Set(out.map((c) => c.email.toLowerCase()));
  for (const c of incoming) {
    const key = c.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Close on outside mousedown / Escape while `enabled` (individual popover only). */
function useDismiss(ref: RefObject<HTMLElement>, enabled: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, enabled, onClose]);
}

interface ContactResult {
  contact: CcBccContact;
  sub: string;
}

/**
 * Cc/Bcc popover: type toggle → pending tray → search/results (+ manual entry)
 * → Apply. Used both per-row (mode 'individual') and across a bulk selection
 * (mode 'bulk'). Owns its own search + pending state; commits via onApply.
 * Always opens fresh (the parent conditionally mounts it), so the tray starts
 * empty and the toggle resets to Cc on every open.
 */
function CcBccPopover({
  mode,
  recipientName,
  recipientCount,
  clients,
  appliedEmails,
  onApply,
  onClose,
}: {
  mode: 'individual' | 'bulk' | 'list' | 'group';
  recipientName?: string;
  recipientCount?: number;
  clients: Client[];
  /** Lowercased emails already applied to the target (excluded from results). */
  appliedEmails: Set<string>;
  onApply: (cc: CcBccContact[], bcc: CcBccContact[]) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [type, setType] = useState<'cc' | 'bcc'>('cc');
  const [pending, setPending] = useState<Array<{ contact: CcBccContact; ccbcc: 'cc' | 'bcc' }>>([]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [manual, setManual] = useState(false);
  const [mFirst, setMFirst] = useState('');
  const [mLast, setMLast] = useState('');
  const [mEmail, setMEmail] = useState('');
  const [mErr, setMErr] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const ql = q.trim().toLowerCase();

  const dir = useQuery<DirectoryApiResponse>({
    queryKey: ['ov2-rs-ccbcc-dir', ql],
    enabled: ql.length > 0,
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: { q: q.trim(), pageSize: 25, sort: 'name-asc' },
        })
      ).data,
  });

  // Reuses the same query keys ClientsTab uses, so client people are served
  // from cache when that tab has already loaded them.
  const peopleQueries = useQueries({
    queries: clients.map((client) => ({
      queryKey: ['ov2-rs-client-people', client.id],
      queryFn: async () => (await api.get<ClientPerson[]>(`/api/clients/${client.id}/people`)).data,
      staleTime: 60_000,
    })),
  });
  const peopleLoading = peopleQueries.some((query) => query.isLoading);
  // Single array reference for the results memo so its dep array has a fixed
  // length (spreading per-query data would vary with clients.length).
  const peopleData = peopleQueries.map((query) => query.data);

  const pendingEmails = useMemo(
    () => new Set(pending.map((p) => p.contact.email.toLowerCase())),
    [pending],
  );
  const excluded = (email: string) =>
    appliedEmails.has(email.toLowerCase()) || pendingEmails.has(email.toLowerCase());

  const { congressResults, clientResults } = useMemo(() => {
    const congress: ContactResult[] = [];
    const client: ContactResult[] = [];
    if (!ql) return { congressResults: congress, clientResults: client };
    const seen = new Set<string>();
    const push = (bucket: ContactResult[], contact: CcBccContact, sub: string) => {
      const key = contact.email.toLowerCase();
      // Hide contacts already applied to this recipient or already in the tray
      // — they can't be added again, so surfacing them would just no-op.
      if (!contact.email || seen.has(key) || appliedEmails.has(key) || pendingEmails.has(key))
        return;
      seen.add(key);
      bucket.push({ contact, sub });
    };
    for (const m of dir.data?.contacts ?? []) {
      if (
        m.email &&
        (m.fullName.toLowerCase().includes(ql) || (m.office ?? '').toLowerCase().includes(ql))
      ) {
        push(
          congress,
          { id: m.id, name: m.fullName, email: m.email, source: 'congress' },
          [m.title, m.office].filter(Boolean).join(' · '),
        );
      }
      for (const s of m.staff ?? []) {
        if (
          s.email &&
          (s.fullName.toLowerCase().includes(ql) || (s.title ?? '').toLowerCase().includes(ql))
        ) {
          push(
            congress,
            { id: `${m.id}:${s.id}`, name: s.fullName, email: s.email, source: 'congress' },
            [s.title || 'Staffer', m.office].filter(Boolean).join(' · '),
          );
        }
      }
    }
    clients.forEach((cl, i) => {
      for (const p of peopleData[i] ?? []) {
        const hay = `${p.name} ${p.title ?? ''} ${p.role ?? ''} ${p.email ?? ''}`.toLowerCase();
        if (p.email && hay.includes(ql)) {
          push(
            client,
            { id: `clientperson:${p.id}`, name: p.name, email: p.email, source: 'client' },
            [p.title || p.role, cl.name].filter(Boolean).join(' · '),
          );
        }
      }
    });
    return { congressResults: congress, clientResults: client };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ql, dir.data, clients, peopleData, appliedEmails, pendingEmails]);

  const addContact = (contact: CcBccContact) => {
    if (excluded(contact.email)) return;
    setPending((p) => [...p, { contact, ccbcc: type }]);
    setSearch('');
    setQ('');
  };
  const removePending = (email: string) =>
    setPending((p) => p.filter((x) => x.contact.email.toLowerCase() !== email.toLowerCase()));

  const addManual = () => {
    const first = mFirst.trim();
    const last = mLast.trim();
    const email = mEmail.trim().toLowerCase();
    if (!first || !last) {
      setMErr('First and last name are required.');
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setMErr('Enter a valid email address.');
      return;
    }
    if (excluded(email)) {
      setMErr('That contact is already added.');
      return;
    }
    setPending((p) => [
      ...p,
      {
        contact: { id: `manual:${email}`, name: `${first} ${last}`, email, source: 'manual' },
        ccbcc: type,
      },
    ]);
    setMFirst('');
    setMLast('');
    setMEmail('');
    setMErr(null);
    setManual(false);
  };

  const apply = () => {
    onApply(
      pending.filter((p) => p.ccbcc === 'cc').map((p) => p.contact),
      pending.filter((p) => p.ccbcc === 'bcc').map((p) => p.contact),
    );
  };

  const count = recipientCount ?? 0;
  const applyLabel =
    mode === 'bulk'
      ? `Apply to ${count} ${count === 1 ? 'recipient' : 'recipients'}`
      : mode === 'list'
        ? 'Apply to entire list'
        : mode === 'group'
          ? 'Apply to group'
          : `Apply to ${recipientName || 'recipient'}`;
  const applyDisabled = pending.length === 0 || (mode === 'bulk' && count === 0);
  const hasResults = congressResults.length > 0 || clientResults.length > 0;

  const renderResult = (r: ContactResult) => (
    <button
      type="button"
      key={r.contact.id}
      className={'ov2-rs-ccbcc-result' + (r.contact.source === 'client' ? ' client' : '')}
      onClick={() => addContact(r.contact)}
    >
      <span className="ov2-rs-ccbcc-avatar">{contactInitials(r.contact.name)}</span>
      <span className="meta">
        <span className="nm">{r.contact.name}</span>
        <span className="sub">{r.sub || r.contact.email}</span>
      </span>
      <span
        className={'ov2-rs-ccbcc-srctag ' + (r.contact.source === 'client' ? 'client' : 'congress')}
      >
        {r.contact.source === 'client' ? 'Client' : 'Congress'}
      </span>
    </button>
  );

  return (
    <div
      className="ov2-rs-ccbcc-pop"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Add Cc or Bcc"
    >
      <div className="ov2-rs-ccbcc-toggle">
        <span className="lbl">Adding as</span>
        <div className="ov2-rs-ccbcc-seg">
          <button
            type="button"
            className={'cc' + (type === 'cc' ? ' active' : '')}
            onClick={() => setType('cc')}
          >
            Cc
          </button>
          <button
            type="button"
            className={'bcc' + (type === 'bcc' ? ' active' : '')}
            onClick={() => setType('bcc')}
          >
            Bcc
          </button>
        </div>
      </div>

      <div className="ov2-rs-ccbcc-tray">
        {pending.length === 0 ? (
          <span className="empty">No contacts added yet</span>
        ) : (
          pending.map((p) => (
            <span key={p.contact.email} className={'ov2-rs-ccpill ' + p.ccbcc}>
              <span className="px">{p.ccbcc === 'cc' ? 'Cc' : 'Bcc'}</span>
              <span className="nm">{p.contact.name}</span>
              <button
                type="button"
                onClick={() => removePending(p.contact.email)}
                aria-label={`Remove ${p.contact.name}`}
              >
                <CloseOutlined />
              </button>
            </span>
          ))
        )}
      </div>

      {manual ? (
        <div className="ov2-rs-ccbcc-manual">
          <div className="names">
            <Input
              size="small"
              placeholder="First name"
              value={mFirst}
              onChange={(e) => setMFirst(e.target.value)}
            />
            <Input
              size="small"
              placeholder="Last name"
              value={mLast}
              onChange={(e) => setMLast(e.target.value)}
            />
          </div>
          <Input
            size="small"
            type="email"
            placeholder="Email address"
            value={mEmail}
            onChange={(e) => setMEmail(e.target.value)}
            onPressEnter={addManual}
          />
          {mErr && <span className="err">{mErr}</span>}
          <div className="manual-actions">
            <Button size="small" type="primary" onClick={addManual}>
              Add
            </Button>
            <Button
              size="small"
              onClick={() => {
                setManual(false);
                setMErr(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Input
            size="small"
            allowClear
            autoFocus
            prefix={<SearchOutlined />}
            placeholder="Search congressional & client contacts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {ql ? (
            hasResults ? (
              <div className="ov2-rs-ccbcc-results">
                {congressResults.length > 0 && (
                  <div className="ov2-rs-ccbcc-grouplabel">Congressional contacts</div>
                )}
                {congressResults.map(renderResult)}
                {clientResults.length > 0 && (
                  <div className="ov2-rs-ccbcc-grouplabel">Client contacts</div>
                )}
                {clientResults.map(renderResult)}
              </div>
            ) : (
              <div className="ov2-rs-ccbcc-hintrow">
                {dir.isFetching || peopleLoading
                  ? 'Searching…'
                  : `No contacts match “${q.trim()}”.`}
              </div>
            )
          ) : (
            <div className="ov2-rs-ccbcc-hintrow">
              Type to search congressional and client contacts.
            </div>
          )}
          <button
            type="button"
            className="ov2-rs-ccbcc-manual-link"
            onClick={() => {
              setManual(true);
              setMErr(null);
            }}
          >
            <UserOutlined /> Add manually by email
          </button>
        </>
      )}

      <div className="ov2-rs-ccbcc-foot">
        <button
          type="button"
          className="ov2-rs-ccbcc-apply"
          disabled={applyDisabled}
          onClick={apply}
        >
          {applyLabel}
        </button>
        {/* ✕ closes the popover. For bulk this returns to the banner (the
            "Add Cc/Bcc to selected" button reopens it); elsewhere it just
            dismisses. Outside-click / Escape do the same. */}
        <button type="button" className="ov2-rs-ccbcc-close" onClick={onClose} aria-label="Close">
          <CloseOutlined />
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// Selected-recipients panel: Individuals first, then Lists, then Groups.
// =====================================================================

function SelectedPanel({
  targets,
  onTargets,
  clients,
}: {
  targets: OutreachTarget[];
  onTargets: (next: OutreachTarget[]) => void;
  clients: Client[];
}) {
  const update = (key: string, patch: Partial<OutreachTarget>) =>
    onTargets(targets.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  const remove = (key: string) => onTargets(targets.filter((t) => t.key !== key));

  const individuals = targets.filter((t) => t.type === 'individual');
  const lists = targets.filter((t) => t.type === 'list');
  const groups = targets.filter((t) => t.type === 'group');

  // Individual Cc/Bcc popover — one open at a time; disabled while bulk mode is on.
  const [openIndividualKey, setOpenIndividualKey] = useState<string | null>(null);
  // Stable so each row's outside-click/Escape listener isn't torn down and
  // re-added on every SelectedPanel re-render.
  const closeIndividual = useCallback(() => setOpenIndividualKey(null), []);

  // Bulk Cc/Bcc mode (individual targets only). Flow: enter bulk → pick
  // recipients in the banner → click "Add Cc/Bcc to selected" to OPEN the modal
  // → Apply. The modal is opened explicitly (not auto-opened) so it's clear you
  // select first, then add. Apply commits to every checked individual and flips
  // the bar to "green".
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPopoverOpen, setBulkPopoverOpen] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const bulkAnchorRef = useRef<HTMLDivElement>(null);
  const closeBulkPopover = useCallback(() => setBulkPopoverOpen(false), []);
  // Outside-click / Escape closes the modal back to the banner (the trigger
  // button reopens it — no dead state).
  useDismiss(bulkAnchorRef, bulkPopoverOpen, closeBulkPopover);

  const enterBulk = () => {
    setOpenIndividualKey(null);
    setSelected(new Set());
    setAppliedCount(null);
    setBulkMode(true);
    setBulkPopoverOpen(false);
  };
  const exitBulk = () => {
    setBulkMode(false);
    setBulkPopoverOpen(false);
    setSelected(new Set());
    setAppliedCount(null);
  };
  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allSelected = individuals.length > 0 && individuals.every((t) => selected.has(t.key));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(individuals.map((t) => t.key)));

  const applyIndividual = (key: string, cc: CcBccContact[], bcc: CcBccContact[]) => {
    const t = targets.find((x) => x.key === key);
    if (!t) return;
    update(key, {
      ccContacts: mergeContacts(t.ccContacts, cc),
      bccContacts: mergeContacts(t.bccContacts, bcc),
    });
    setOpenIndividualKey(null);
  };

  const applyBulk = (cc: CcBccContact[], bcc: CcBccContact[]) => {
    onTargets(
      targets.map((t) =>
        t.type === 'individual' && selected.has(t.key)
          ? {
              ...t,
              ccContacts: mergeContacts(t.ccContacts, cc),
              bccContacts: mergeContacts(t.bccContacts, bcc),
            }
          : t,
      ),
    );
    setAppliedCount(selected.size);
    setBulkPopoverOpen(false);
  };

  const selectedCount = selected.size;

  return (
    <div className="ov2-rs-panel">
      {bulkMode &&
        (appliedCount != null && !bulkPopoverOpen ? (
          <div className="ov2-rs-bulkbar2 green">
            <span className="txt">
              <CheckOutlined /> Applied to {appliedCount}{' '}
              {appliedCount === 1 ? 'recipient' : 'recipients'}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="act"
              onClick={() => {
                setAppliedCount(null);
                setBulkPopoverOpen(true);
              }}
            >
              Add more
            </button>
            <button type="button" className="ghost" onClick={exitBulk}>
              Done
            </button>
          </div>
        ) : (
          <div className="ov2-rs-bulkbar2 blue">
            <span className="txt">
              {selectedCount > 0
                ? `${selectedCount} ${selectedCount === 1 ? 'recipient' : 'recipients'} selected`
                : 'Select recipients to add Cc/Bcc'}
            </span>
            <span className="spacer" />
            <div className="ov2-rs-ccbcc-anchor" ref={bulkAnchorRef}>
              <button
                type="button"
                className={'act' + (bulkPopoverOpen ? ' is-open' : '')}
                disabled={selectedCount === 0}
                title={selectedCount === 0 ? 'Select at least one recipient first' : undefined}
                onClick={() => setBulkPopoverOpen((o) => !o)}
              >
                Add Cc/Bcc to selected
              </button>
              {bulkPopoverOpen && (
                <CcBccPopover
                  mode="bulk"
                  recipientCount={selectedCount}
                  clients={clients}
                  appliedEmails={new Set()}
                  onApply={applyBulk}
                  onClose={closeBulkPopover}
                />
              )}
            </div>
            <button type="button" className="ghost" onClick={exitBulk}>
              Cancel
            </button>
          </div>
        ))}

      {/* All individual recipients live in one Individuals card (mirrors the
          List/Group cards). The Bulk Cc/Bcc trigger lives in this card's
          header. */}
      {individuals.length > 0 && (
        <div className="ov2-rs-entity individual">
          <div className="ov2-rs-entity-head">
            <span className="ov2-rs-type-badge individual">
              <UserOutlined /> Individual
            </span>
            <span className="count">· {plural(individuals.length, 'recipient')}</span>
            <span className="note blue">Each receives their own personalized email</span>
            <span className="spacer" />
            {!bulkMode && (
              <button type="button" className="ov2-rs-bulk-btn" onClick={enterBulk}>
                <UnorderedListOutlined /> Bulk Cc/Bcc
              </button>
            )}
          </div>

          {bulkMode && (
            <div className="ov2-rs-selectall">
              <Checkbox
                checked={allSelected}
                indeterminate={selectedCount > 0 && !allSelected}
                onChange={toggleSelectAll}
              >
                Select all
              </Checkbox>
              <span className="count">
                {selectedCount} of {individuals.length} selected
              </span>
            </div>
          )}

          <div className="ov2-rs-indrows">
            {individuals.map((t) => (
              <IndividualRow
                key={t.key}
                target={t}
                clients={clients}
                bulkMode={bulkMode}
                checked={selected.has(t.key)}
                onToggleChecked={() => toggleSelected(t.key)}
                popoverOpen={openIndividualKey === t.key}
                onOpenPopover={() => setOpenIndividualKey(t.key)}
                onClosePopover={closeIndividual}
                onApply={(cc, bcc) => applyIndividual(t.key, cc, bcc)}
                onUpdate={(patch) => update(t.key, patch)}
                onRemove={() => remove(t.key)}
              />
            ))}
          </div>
        </div>
      )}

      {lists.map((t) => (
        <ListEntity
          key={t.key}
          target={t}
          clients={clients}
          onUpdate={(patch) => update(t.key, patch)}
          onRemove={() => remove(t.key)}
        />
      ))}

      {groups.map((t) => (
        <GroupEntity
          key={t.key}
          target={t}
          clients={clients}
          onUpdate={(patch) => update(t.key, patch)}
          onRemove={() => remove(t.key)}
        />
      ))}

      {bulkMode && (
        <div className="ov2-rs-bulk-hint">
          <InfoCircleOutlined /> Click Done to exit bulk mode and re-enable individual Cc/Bcc.
        </div>
      )}
    </div>
  );
}

function IndividualRow({
  target,
  clients,
  bulkMode,
  checked,
  onToggleChecked,
  popoverOpen,
  onOpenPopover,
  onClosePopover,
  onApply,
  onUpdate,
  onRemove,
}: {
  target: OutreachTarget;
  clients: Client[];
  bulkMode: boolean;
  checked: boolean;
  onToggleChecked: () => void;
  popoverOpen: boolean;
  onOpenPopover: () => void;
  onClosePopover: () => void;
  onApply: (cc: CcBccContact[], bcc: CcBccContact[]) => void;
  onUpdate: (patch: Partial<OutreachTarget>) => void;
  onRemove: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  // The per-row popover dismisses on outside click / Escape. Bulk mode disables
  // the individual button entirely, so there's nothing to dismiss then.
  useDismiss(anchorRef, popoverOpen && !bulkMode, onClosePopover);
  const renderLastContact = useContext(LastContactContext);

  const r = target.recipients[0];
  if (!r) return null;
  const cc = target.ccContacts ?? [];
  const bcc = target.bccContacts ?? [];
  const appliedEmails = new Set([...cc, ...bcc].map((c) => c.email.toLowerCase()));

  // A single recipient row inside the Individuals card. The "Individual" badge
  // and "receives their own personalized email" note live on the card header,
  // so they aren't repeated per row.
  return (
    <div className={'ov2-rs-indrow' + (bulkMode && checked ? ' bulk-selected' : '')}>
      {bulkMode && (
        <Checkbox
          className="ov2-rs-row-check"
          checked={checked}
          onChange={onToggleChecked}
          aria-label={`Select ${r.name || r.email || 'recipient'}`}
        />
      )}
      <span className="name">{r.name || r.email || 'Recipient'}</span>
      {r.email && <span className="email">{r.email}</span>}
      {renderLastContact(r.email)}
      {cc.map((c) => (
        <span key={`cc-${c.email}`} className="ov2-rs-ccpill cc">
          <span className="px">Cc</span>
          <span className="nm">{c.name}</span>
          <button
            type="button"
            onClick={() => onUpdate({ ccContacts: cc.filter((x) => x.email !== c.email) })}
            aria-label={`Remove Cc ${c.name}`}
          >
            <CloseOutlined />
          </button>
        </span>
      ))}
      {bcc.map((c) => (
        <span key={`bcc-${c.email}`} className="ov2-rs-ccpill bcc">
          <span className="px">Bcc</span>
          <span className="nm">{c.name}</span>
          <button
            type="button"
            onClick={() => onUpdate({ bccContacts: bcc.filter((x) => x.email !== c.email) })}
            aria-label={`Remove Bcc ${c.name}`}
          >
            <CloseOutlined />
          </button>
        </span>
      ))}
      <span className="spacer" />
      <div className="ov2-rs-ccbcc-anchor" ref={anchorRef}>
        <button
          type="button"
          className={'ov2-rs-ccbcc-btn' + (popoverOpen ? ' open' : '')}
          disabled={bulkMode}
          title={bulkMode ? 'Individual Cc/Bcc is disabled while bulk mode is active' : undefined}
          onClick={() => (popoverOpen ? onClosePopover() : onOpenPopover())}
        >
          Add Cc/Bcc
        </button>
        {popoverOpen && !bulkMode && (
          <CcBccPopover
            mode="individual"
            recipientName={r.name || r.email || 'recipient'}
            clients={clients}
            appliedEmails={appliedEmails}
            onApply={onApply}
            onClose={onClosePopover}
          />
        )}
      </div>
      <button type="button" className="ov2-rs-remove" onClick={onRemove} aria-label="Remove">
        <CloseOutlined />
      </button>
    </div>
  );
}

function ListEntity({
  target,
  clients,
  onUpdate,
  onRemove,
}: {
  target: OutreachTarget;
  clients: Client[];
  onUpdate: (patch: Partial<OutreachTarget>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  // One Cc/Bcc popover open at a time within this list: 'entire' for the
  // whole-list popover, or a member's recipientKey for that member's popover.
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const entireAnchorRef = useRef<HTMLDivElement>(null);
  const entireOpen = openPopover === 'entire';
  const closePopover = useCallback(() => setOpenPopover(null), []);
  useDismiss(entireAnchorRef, entireOpen, closePopover);

  const listCc = target.ccContacts ?? [];
  const listBcc = target.bccContacts ?? [];
  // Emails copied on the whole list — excluded from BOTH the entire-list and
  // the per-member popovers (already on everyone, so re-adding is redundant).
  const listAppliedEmails = new Set([...listCc, ...listBcc].map((c) => c.email.toLowerCase()));

  const dropMember = (key: string) => {
    const recipients = target.recipients.filter((r) => recipientKey(r) !== key);
    if (recipients.length === 0) {
      onRemove();
      return;
    }
    const { [key]: _cc, ...memberCc } = target.memberCc ?? {};
    const { [key]: _bcc, ...memberBcc } = target.memberBcc ?? {};
    const { [key]: _ccc, ...memberCcContacts } = target.memberCcContacts ?? {};
    const { [key]: _bccc, ...memberBccContacts } = target.memberBccContacts ?? {};
    onUpdate({ recipients, memberCc, memberBcc, memberCcContacts, memberBccContacts });
  };

  const applyEntire = (cc: CcBccContact[], bcc: CcBccContact[]) => {
    onUpdate({
      ccContacts: mergeContacts(target.ccContacts, cc),
      bccContacts: mergeContacts(target.bccContacts, bcc),
    });
    closePopover();
  };
  const applyMember = (key: string, cc: CcBccContact[], bcc: CcBccContact[]) => {
    onUpdate({
      memberCcContacts: {
        ...(target.memberCcContacts ?? {}),
        [key]: mergeContacts(target.memberCcContacts?.[key], cc),
      },
      memberBccContacts: {
        ...(target.memberBccContacts ?? {}),
        [key]: mergeContacts(target.memberBccContacts?.[key], bcc),
      },
    });
    closePopover();
  };
  const removeMemberContact = (key: string, kind: 'cc' | 'bcc', email: string) => {
    if (kind === 'cc') {
      const next = (target.memberCcContacts?.[key] ?? []).filter((c) => c.email !== email);
      onUpdate({ memberCcContacts: { ...(target.memberCcContacts ?? {}), [key]: next } });
    } else {
      const next = (target.memberBccContacts?.[key] ?? []).filter((c) => c.email !== email);
      onUpdate({ memberBccContacts: { ...(target.memberBccContacts ?? {}), [key]: next } });
    }
  };

  return (
    <div className="ov2-rs-entity list">
      <div className="ov2-rs-entity-head">
        <button
          type="button"
          className="ov2-rs-caret"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Collapse list' : 'Expand list'}
        >
          {open ? <DownOutlined /> : <RightOutlined />}
        </button>
        <span className="ov2-rs-type-badge list">
          <UnorderedListOutlined /> List
        </span>
        <span className="name">{target.name || 'Untitled list'}</span>
        <span className="count">· {plural(target.recipients.length, 'contact')}</span>
        <span className="note green">
          <UserOutlined /> Each emailed individually
        </span>
        <span className="spacer" />
        <div className="ov2-rs-ccbcc-anchor" ref={entireAnchorRef}>
          <button
            type="button"
            className={'ov2-rs-ccbcc-btn' + (entireOpen ? ' open' : '')}
            onClick={() => setOpenPopover(entireOpen ? null : 'entire')}
          >
            Cc/Bcc Entire List
          </button>
          {entireOpen && (
            <CcBccPopover
              mode="list"
              clients={clients}
              appliedEmails={listAppliedEmails}
              onApply={applyEntire}
              onClose={closePopover}
            />
          )}
        </div>
        <button type="button" className="ov2-rs-remove" onClick={onRemove} aria-label="Remove list">
          <CloseOutlined />
        </button>
      </div>

      {(listCc.length > 0 || listBcc.length > 0) && (
        <div className="ov2-rs-list-everyone">
          <span className="lbl">Everyone in this list:</span>
          {listCc.map((c) => (
            <span key={`cc-${c.email}`} className="ov2-rs-ccpill cc">
              <span className="px">Cc</span>
              <span className="nm">{c.name}</span>
              <button
                type="button"
                onClick={() => onUpdate({ ccContacts: listCc.filter((x) => x.email !== c.email) })}
                aria-label={`Remove Cc ${c.name}`}
              >
                <CloseOutlined />
              </button>
            </span>
          ))}
          {listBcc.map((c) => (
            <span key={`bcc-${c.email}`} className="ov2-rs-ccpill bcc">
              <span className="px">Bcc</span>
              <span className="nm">{c.name}</span>
              <button
                type="button"
                onClick={() =>
                  onUpdate({ bccContacts: listBcc.filter((x) => x.email !== c.email) })
                }
                aria-label={`Remove Bcc ${c.name}`}
              >
                <CloseOutlined />
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="ov2-rs-members">
          {target.recipients.map((r) => {
            const key = recipientKey(r);
            return (
              <ListMemberRow
                key={key}
                recipient={r}
                clients={clients}
                memberCc={target.memberCcContacts?.[key] ?? []}
                memberBcc={target.memberBccContacts?.[key] ?? []}
                listAppliedEmails={listAppliedEmails}
                open={openPopover === key}
                onOpen={() => setOpenPopover(key)}
                onClose={closePopover}
                onApply={(cc, bcc) => applyMember(key, cc, bcc)}
                onRemoveContact={(kind, email) => removeMemberContact(key, kind, email)}
                onDrop={() => dropMember(key)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// One member row inside a List: shows the member's per-member Cc/Bcc pills and
// an Add Cc/Bcc popover scoped to that member (behaves like an individual row).
function ListMemberRow({
  recipient,
  clients,
  memberCc,
  memberBcc,
  listAppliedEmails,
  open,
  onOpen,
  onClose,
  onApply,
  onRemoveContact,
  onDrop,
}: {
  recipient: OutreachRecipient;
  clients: Client[];
  memberCc: CcBccContact[];
  memberBcc: CcBccContact[];
  listAppliedEmails: Set<string>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onApply: (cc: CcBccContact[], bcc: CcBccContact[]) => void;
  onRemoveContact: (kind: 'cc' | 'bcc', email: string) => void;
  onDrop: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismiss(anchorRef, open, onClose);
  const renderLastContact = useContext(LastContactContext);
  const appliedEmails = new Set([
    ...listAppliedEmails,
    ...[...memberCc, ...memberBcc].map((c) => c.email.toLowerCase()),
  ]);
  return (
    <div className="ov2-rs-member">
      <span className="bullet">•</span>
      <span className="name">{recipient.name || recipient.email}</span>
      {recipient.email && <span className="email">{recipient.email}</span>}
      {renderLastContact(recipient.email)}
      {memberCc.map((c) => (
        <span key={`cc-${c.email}`} className="ov2-rs-ccpill cc">
          <span className="px">Cc</span>
          <span className="nm">{c.name}</span>
          <button
            type="button"
            onClick={() => onRemoveContact('cc', c.email)}
            aria-label={`Remove Cc ${c.name}`}
          >
            <CloseOutlined />
          </button>
        </span>
      ))}
      {memberBcc.map((c) => (
        <span key={`bcc-${c.email}`} className="ov2-rs-ccpill bcc">
          <span className="px">Bcc</span>
          <span className="nm">{c.name}</span>
          <button
            type="button"
            onClick={() => onRemoveContact('bcc', c.email)}
            aria-label={`Remove Bcc ${c.name}`}
          >
            <CloseOutlined />
          </button>
        </span>
      ))}
      <span className="spacer" />
      <div className="ov2-rs-ccbcc-anchor" ref={anchorRef}>
        <button
          type="button"
          className={'ov2-rs-ccbcc-btn' + (open ? ' open' : '')}
          onClick={() => (open ? onClose() : onOpen())}
        >
          Add Cc/Bcc
        </button>
        {open && (
          <CcBccPopover
            mode="individual"
            recipientName={recipient.name || recipient.email || 'recipient'}
            clients={clients}
            appliedEmails={appliedEmails}
            onApply={onApply}
            onClose={onClose}
          />
        )}
      </div>
      <button
        type="button"
        className="ov2-rs-remove small"
        onClick={onDrop}
        aria-label="Drop from this campaign"
      >
        <CloseOutlined />
      </button>
    </div>
  );
}

function GroupEntity({
  target,
  clients,
  onUpdate,
  onRemove,
}: {
  target: OutreachTarget;
  clients: Client[];
  onUpdate: (patch: Partial<OutreachTarget>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const renderLastContact = useContext(LastContactContext);
  const anchorRef = useRef<HTMLDivElement>(null);
  const closePopover = useCallback(() => setPopoverOpen(false), []);
  useDismiss(anchorRef, popoverOpen, closePopover);

  // A group is one shared email, so its Cc/Bcc is a single group-level set —
  // same contact popover as individuals/lists (no per-member Cc/Bcc).
  const cc = target.ccContacts ?? [];
  const bcc = target.bccContacts ?? [];
  const appliedEmails = new Set([...cc, ...bcc].map((c) => c.email.toLowerCase()));

  const dropMember = (key: string) => {
    const recipients = target.recipients.filter((r) => recipientKey(r) !== key);
    if (recipients.length === 0) {
      onRemove();
      return;
    }
    onUpdate({ recipients });
  };

  const applyGroup = (ccNew: CcBccContact[], bccNew: CcBccContact[]) => {
    onUpdate({ ccContacts: mergeContacts(cc, ccNew), bccContacts: mergeContacts(bcc, bccNew) });
    setPopoverOpen(false);
  };

  return (
    <div className="ov2-rs-entity group">
      <div className="ov2-rs-entity-head">
        <button
          type="button"
          className="ov2-rs-caret"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Collapse group' : 'Expand group'}
        >
          {open ? <DownOutlined /> : <RightOutlined />}
        </button>
        <span className="ov2-rs-type-badge group">
          <TeamOutlined /> Group
        </span>
        <span className="name">{target.name || 'Untitled group'}</span>
        <span className="count">· {plural(target.recipients.length, 'contact')}</span>
        <span className="note amber">This group receives 1 email together</span>
        {cc.map((c) => (
          <span key={`cc-${c.email}`} className="ov2-rs-ccpill cc">
            <span className="px">Cc</span>
            <span className="nm">{c.name}</span>
            <button
              type="button"
              onClick={() => onUpdate({ ccContacts: cc.filter((x) => x.email !== c.email) })}
              aria-label={`Remove Cc ${c.name}`}
            >
              <CloseOutlined />
            </button>
          </span>
        ))}
        {bcc.map((c) => (
          <span key={`bcc-${c.email}`} className="ov2-rs-ccpill bcc">
            <span className="px">Bcc</span>
            <span className="nm">{c.name}</span>
            <button
              type="button"
              onClick={() => onUpdate({ bccContacts: bcc.filter((x) => x.email !== c.email) })}
              aria-label={`Remove Bcc ${c.name}`}
            >
              <CloseOutlined />
            </button>
          </span>
        ))}
        <span className="spacer" />
        <div className="ov2-rs-ccbcc-anchor" ref={anchorRef}>
          <button
            type="button"
            className={'ov2-rs-ccbcc-btn amber' + (popoverOpen ? ' open' : '')}
            onClick={() => setPopoverOpen((o) => !o)}
          >
            Add Cc/Bcc
          </button>
          {popoverOpen && (
            <CcBccPopover
              mode="group"
              clients={clients}
              appliedEmails={appliedEmails}
              onApply={applyGroup}
              onClose={closePopover}
            />
          )}
        </div>
        <button
          type="button"
          className="ov2-rs-remove"
          onClick={onRemove}
          aria-label="Remove group"
        >
          <CloseOutlined />
        </button>
      </div>
      {open && (
        <div className="ov2-rs-members">
          {target.recipients.map((r) => {
            const key = recipientKey(r);
            return (
              <div key={key} className="ov2-rs-member">
                <span className="bullet">•</span>
                <span className="name">{r.name || r.email}</span>
                {r.email && <span className="email">{r.email}</span>}
                {renderLastContact(r.email)}
                <span className="spacer" />
                <button
                  type="button"
                  className="ov2-rs-remove small"
                  onClick={() => dropMember(key)}
                  aria-label="Drop from this group's send"
                >
                  <CloseOutlined />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Tab 1 — Congressional Directory
// =====================================================================

function CongressTab({
  targets,
  builderKind,
  builderHas,
  onBuilderToggle,
  onAdd,
  onRemoveIndividual,
  listsPopover,
  listsOpen,
  onListsOpenChange,
  groupsPopover,
  groupsOpen,
  onGroupsOpenChange,
  builderBanner,
  appliedChips,
}: {
  targets: OutreachTarget[];
  builderKind: 'list' | 'group' | null;
  builderHas: (key: string) => boolean;
  onBuilderToggle: (r: OutreachRecipient) => void;
  onAdd: (r: OutreachRecipient) => void;
  onRemoveIndividual: (key: string) => void;
  listsPopover: ReactNode;
  listsOpen: boolean;
  onListsOpenChange: (open: boolean) => void;
  groupsPopover: ReactNode;
  groupsOpen: boolean;
  onGroupsOpenChange: (open: boolean) => void;
  builderBanner: ReactNode;
  appliedChips: ReactNode;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState<string | undefined>();
  const [chamberFilter, setChamberFilter] = useState<string | undefined>();
  const [favOnly, setFavOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(() => setQ(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const dir = useQuery<DirectoryApiResponse>({
    queryKey: ['ov2-rs-directory', q, stateFilter ?? '', chamberFilter ?? ''],
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: {
            q: q || undefined,
            state: stateFilter,
            chamber: chamberFilter,
            pageSize: 50,
            // Always A–Z: omitting sort makes the backend default to
            // 'recent' (lastTouchpoint), which reads as arbitrary ordering.
            sort: 'name-asc',
          },
        })
      ).data,
  });

  const favorites = useQuery<FavoriteRow[]>({
    queryKey: ['directory-favorites'],
    queryFn: async () => (await api.get<FavoriteRow[]>('/api/directory/favorites')).data,
  });
  // The favorites store is shared with the Client Contacts tab (which writes
  // namespaced `clientperson:` ids) — exclude those here so the (n) count and
  // the favorites filter only reflect directory members/staffers.
  const favSet = useMemo(
    () =>
      new Set(
        (favorites.data ?? [])
          .filter((f) => !f.directoryContactId.startsWith('clientperson:'))
          .map((f) => f.directoryContactId),
      ),
    [favorites.data],
  );
  const toggleFavorite = useMutation({
    mutationFn: async (vars: { id: string; name: string; favorited: boolean }) =>
      vars.favorited
        ? (await api.delete(`/api/directory/contacts/${encodeURIComponent(vars.id)}/favorite`)).data
        : (
            await api.post(`/api/directory/contacts/${encodeURIComponent(vars.id)}/favorite`, {
              directoryContactName: vars.name,
            })
          ).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ['directory-favorites'] }),
  });

  const rows = (dir.data?.contacts ?? []).filter((e) => !favOnly || favSet.has(e.id));
  const states = dir.data?.availableStates ?? [];
  const chambers = dir.data?.availableFilters.chambers ?? [];

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <div className="ov2-rs-toolbar">
        <Input
          className="search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search members and staffers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          allowClear
          placeholder="State"
          style={{ width: 100 }}
          value={stateFilter}
          onChange={(v) => setStateFilter(v)}
          options={states.map((s) => ({ value: s, label: s }))}
          showSearch
        />
        <Select
          allowClear
          placeholder="Chamber"
          style={{ width: 120 }}
          value={chamberFilter}
          onChange={(v) => setChamberFilter(v)}
          options={chambers.map((c) => ({ value: c, label: c }))}
        />
        <button
          type="button"
          className={'ov2-rs-toolbar-btn' + (favOnly ? ' fav-on' : '')}
          onClick={() => setFavOnly((f) => !f)}
        >
          {favOnly ? <StarFilled /> : <StarOutlined />} Favorites ({favSet.size})
        </button>
        <Dropdown
          dropdownRender={() => <>{listsPopover}</>}
          trigger={['click']}
          open={listsOpen}
          onOpenChange={onListsOpenChange}
        >
          <button type="button" className="ov2-rs-toolbar-btn lists">
            <UnorderedListOutlined /> Lists <DownOutlined style={{ fontSize: 10 }} />
          </button>
        </Dropdown>
        <Dropdown
          dropdownRender={() => <>{groupsPopover}</>}
          trigger={['click']}
          open={groupsOpen}
          onOpenChange={onGroupsOpenChange}
        >
          <button type="button" className="ov2-rs-toolbar-btn groups">
            <TeamOutlined /> Groups <DownOutlined style={{ fontSize: 10 }} />
          </button>
        </Dropdown>
      </div>
      {builderBanner}
      {appliedChips}
      <div className="ov2-rs-hint">
        {builderKind === 'group'
          ? 'Check members to include in the group. All checked recipients will receive one email together.'
          : builderKind === 'list'
            ? 'Check members and staffers to include them in the list. Each checked recipient gets their own email.'
            : 'Showing the directory A–Z. Click + on any member or staffer to add them to To. Use the caret to expand staffers.'}
      </div>

      <div className="ov2-rs-table">
        <div className="ov2-rs-thead congress">
          <span />
          <span>Name</span>
          <span>Office</span>
          <span>Committee</span>
          <span>State</span>
          <span>Party</span>
          <span />
        </div>
        <div className="ov2-rs-rows">
          {dir.isLoading ? (
            <div className="ov2-rs-empty">Loading the directory…</div>
          ) : rows.length === 0 ? (
            <div className="ov2-rs-empty">
              {favOnly
                ? 'No favorites in the current results. Star members to find them faster.'
                : 'No members match. Try a different search or filter.'}
            </div>
          ) : (
            rows.map((entry) => (
              <MemberRows
                key={entry.id}
                entry={entry}
                targets={targets}
                expanded={expanded.has(entry.id)}
                onToggleExpand={() => toggleExpand(entry.id)}
                favorited={favSet.has(entry.id)}
                onToggleFavorite={() =>
                  toggleFavorite.mutate({
                    id: entry.id,
                    name: entry.fullName,
                    favorited: favSet.has(entry.id),
                  })
                }
                builderKind={builderKind}
                builderHas={builderHas}
                onBuilderToggle={onBuilderToggle}
                onAdd={onAdd}
                onRemoveIndividual={onRemoveIndividual}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function AddControl({
  recipient,
  targets,
  builderKind,
  builderHas,
  onBuilderToggle,
  onAdd,
  onRemoveIndividual,
}: {
  recipient: OutreachRecipient;
  targets: OutreachTarget[];
  builderKind: 'list' | 'group' | null;
  builderHas: (key: string) => boolean;
  onBuilderToggle: (r: OutreachRecipient) => void;
  onAdd: (r: OutreachRecipient) => void;
  onRemoveIndividual: (key: string) => void;
}) {
  const key = recipientKey(recipient);
  // Group membership is orthogonal — the "+" stays available for someone who is
  // only in a group (they can still get their own individual email). Only an
  // existing individual / list slot marks the row as added.
  const membership = membershipOf(targets, key, 'personal');
  // While building a LIST the "+" is disabled (but still shown) so it's
  // unmistakable that the checkbox — not the "+" — is how you add people to the
  // new list. (Groups hide the "+" entirely, below.)
  const addDisabled = builderKind === 'list';
  const addButton = membership ? (
    <button
      type="button"
      className="ov2-rs-add added"
      disabled={addDisabled}
      title={
        addDisabled
          ? 'Use the checkbox to add to the list'
          : membership === 'individual'
            ? 'Added to To — click to remove'
            : 'Already in a list — manage it in the panel above'
      }
      onClick={() => !addDisabled && membership === 'individual' && onRemoveIndividual(key)}
      aria-label="Added"
    >
      <CheckOutlined />
    </button>
  ) : (
    <button
      type="button"
      className="ov2-rs-add"
      disabled={addDisabled}
      title={addDisabled ? 'Use the checkbox to add to the list' : undefined}
      onClick={() => !addDisabled && onAdd(recipient)}
      aria-label="Add to To"
    >
      <PlusOutlined />
    </button>
  );
  if (builderKind) {
    // Build mode: the checkbox collects people into the new list/group.
    // Lists (board 5b) keep the + alongside but DISABLED, so the checkbox is the
    // only live control (it wasn't clear you had to check a box); groups
    // (board 7b) hide + — checked rows tint amber and the checkbox is amber —
    // because a group is built only from the checked set.
    return (
      <>
        <Checkbox
          className={'ov2-rs-checkbox' + (builderKind === 'group' ? ' amber' : '')}
          checked={builderHas(key)}
          onChange={() => onBuilderToggle(recipient)}
        />
        {builderKind === 'group' ? null : addButton}
      </>
    );
  }
  return addButton;
}

function MemberRows({
  entry,
  targets,
  expanded,
  onToggleExpand,
  favorited,
  onToggleFavorite,
  builderKind,
  builderHas,
  onBuilderToggle,
  onAdd,
  onRemoveIndividual,
}: {
  entry: DirectoryEntry;
  targets: OutreachTarget[];
  expanded: boolean;
  onToggleExpand: () => void;
  favorited: boolean;
  onToggleFavorite: () => void;
  builderKind: 'list' | 'group' | null;
  builderHas: (key: string) => boolean;
  onBuilderToggle: (r: OutreachRecipient) => void;
  onAdd: (r: OutreachRecipient) => void;
  onRemoveIndividual: (key: string) => void;
}) {
  const recipient = fromDirectoryEntry(entry);
  const membership = membershipOf(targets, recipientKey(recipient));
  const tag = membership ? MEMBERSHIP_TAG[membership] : null;
  const role = entry.leadershipPositions[0] || entry.title;
  // While building a group, a checked row tints amber (board 7b).
  const groupChecked = builderKind === 'group' && builderHas(recipientKey(recipient));

  return (
    <>
      <div
        className={
          'ov2-rs-row congress' +
          (membership ? ' added' : '') +
          (groupChecked ? ' group-checked' : '')
        }
      >
        <span className="controls">
          <button
            type="button"
            className="ov2-rs-caret"
            onClick={onToggleExpand}
            aria-label={expanded ? 'Collapse staffers' : 'Expand staffers'}
          >
            {expanded ? <DownOutlined /> : <RightOutlined />}
          </button>
          <AddControl
            recipient={recipient}
            targets={targets}
            builderKind={builderKind}
            builderHas={builderHas}
            onBuilderToggle={onBuilderToggle}
            onAdd={onAdd}
            onRemoveIndividual={onRemoveIndividual}
          />
          <button
            type="button"
            className={'ov2-rs-star' + (favorited ? ' on' : '')}
            onClick={onToggleFavorite}
            aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
          >
            {favorited ? <StarFilled /> : <StarOutlined />}
          </button>
        </span>
        <span className="who">
          <div className="nm">{entry.fullName}</div>
          <div className="sub">{role}</div>
        </span>
        <span className="ov2-rs-cell" title={entry.office}>
          {entry.office || '—'}
        </span>
        <span className="ov2-rs-cell" title={entry.committees.join(', ')}>
          {entry.committees[0] || '—'}
        </span>
        <span className="ov2-rs-cell">{entry.state}</span>
        <span>
          <span className={'ov2-rs-pill' + (entry.partyName === 'Republican' ? ' republican' : '')}>
            {entry.partyName}
          </span>
        </span>
        {tag ? <span className={`ov2-rs-intag ${tag.cls}`}>{tag.text}</span> : <span />}
      </div>
      {expanded &&
        (entry.staff.length === 0 ? (
          <div className="ov2-rs-row congress sub">
            <span />
            <span className="who">
              <div className="sub">No staffer contacts synced for this office.</div>
            </span>
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        ) : (
          entry.staff.map((staffer) => {
            const sr = stafferRecipient(entry, staffer);
            const sMembership = membershipOf(targets, recipientKey(sr));
            const sTag = sMembership ? MEMBERSHIP_TAG[sMembership] : null;
            const sGroupChecked = builderKind === 'group' && builderHas(recipientKey(sr));
            return (
              <div
                key={staffer.id}
                className={
                  'ov2-rs-row congress sub' +
                  (sMembership ? ' added' : '') +
                  (sGroupChecked ? ' group-checked' : '')
                }
              >
                <span className="controls">
                  <AddControl
                    recipient={sr}
                    targets={targets}
                    builderKind={builderKind}
                    builderHas={builderHas}
                    onBuilderToggle={onBuilderToggle}
                    onAdd={onAdd}
                    onRemoveIndividual={onRemoveIndividual}
                  />
                </span>
                <span className="who">
                  <div className="nm">{staffer.fullName}</div>
                  <div className="sub">{staffer.title || 'Staffer'}</div>
                </span>
                <span className="ov2-rs-cell">{entry.office || '—'}</span>
                <span className="ov2-rs-cell">{staffer.issueAreas[0] || '—'}</span>
                <span className="ov2-rs-cell">{entry.state}</span>
                <span />
                {sTag ? <span className={`ov2-rs-intag ${sTag.cls}`}>{sTag.text}</span> : <span />}
              </div>
            );
          })
        ))}
    </>
  );
}

// =====================================================================
// Tab — State Legislators (OpenStates directory, filterable by state +
// committee). Structurally mirrors CongressTab: a single directory query,
// server-side filters, the shared Lists/Groups build machinery, and the
// shared AddControl. State legislators have no synced staffers, so rows are
// flat (no member→staffer expansion) and there is no favorites store (the
// favorites API is scoped to the federal congressional directory).
// =====================================================================

function StateLegislatorsTab({
  targets,
  builderKind,
  builderHas,
  onBuilderToggle,
  onAdd,
  onRemoveIndividual,
  listsPopover,
  listsOpen,
  onListsOpenChange,
  groupsPopover,
  groupsOpen,
  onGroupsOpenChange,
  builderBanner,
  appliedChips,
}: {
  targets: OutreachTarget[];
  builderKind: 'list' | 'group' | null;
  builderHas: (key: string) => boolean;
  onBuilderToggle: (r: OutreachRecipient) => void;
  onAdd: (r: OutreachRecipient) => void;
  onRemoveIndividual: (key: string) => void;
  listsPopover: ReactNode;
  listsOpen: boolean;
  onListsOpenChange: (open: boolean) => void;
  groupsPopover: ReactNode;
  groupsOpen: boolean;
  onGroupsOpenChange: (open: boolean) => void;
  builderBanner: ReactNode;
  appliedChips: ReactNode;
}) {
  const api = useApi();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState<string | undefined>();
  const [committeeFilter, setCommitteeFilter] = useState<string | undefined>();

  useEffect(() => {
    const timer = setTimeout(() => setQ(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Facets: states are global; committees are scoped to the selected state
  // (there are thousands nationwide with state-specific names). Refetched when
  // the state changes so the committee picker only offers that state's bodies.
  const facets = useQuery<StateLegislatorFacetsResponse>({
    queryKey: ['ov2-rs-statelegis-facets', stateFilter ?? ''],
    queryFn: async () =>
      (
        await api.get<StateLegislatorFacetsResponse>('/api/explorer/state-legislator-facets', {
          params: { states: stateFilter },
        })
      ).data,
    staleTime: 10 * 60_000,
  });

  const dir = useQuery<StateLegislatorListResponse>({
    queryKey: ['ov2-rs-statelegis', q, stateFilter ?? '', committeeFilter ?? ''],
    queryFn: async () =>
      (
        await api.get<StateLegislatorListResponse>('/api/explorer/state-legislators', {
          params: {
            q: q || undefined,
            states: stateFilter,
            committee: committeeFilter,
            includeCommittees: true,
            // A single state fits comfortably; without one this is a partial
            // A–Z browse and the filters are how you narrow.
            pageSize: 200,
          },
        })
      ).data,
  });

  const rows = dir.data?.rows ?? [];
  const states = facets.data?.states ?? [];
  const committees = facets.data?.committees ?? [];

  return (
    <div>
      <div className="ov2-rs-toolbar">
        <Input
          className="search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search state legislators…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          allowClear
          showSearch
          placeholder="State"
          style={{ width: 100 }}
          value={stateFilter}
          // Committee names are state-specific, so a lingering committee filter
          // would be meaningless (and yield nothing) under a new state — clear
          // it whenever the state changes.
          onChange={(v) => {
            setStateFilter(v);
            setCommitteeFilter(undefined);
          }}
          options={states.map((s) => ({ value: s, label: s }))}
        />
        <Select
          allowClear
          showSearch
          placeholder={stateFilter ? 'Committee' : 'Pick a state first'}
          style={{ width: 240 }}
          disabled={!stateFilter}
          value={committeeFilter}
          onChange={(v) => setCommitteeFilter(v)}
          options={committees.map((c) => ({ value: c, label: c }))}
          notFoundContent={
            facets.isFetching ? 'Loading committees…' : 'No committees for this state'
          }
        />
        <Dropdown
          dropdownRender={() => <>{listsPopover}</>}
          trigger={['click']}
          open={listsOpen}
          onOpenChange={onListsOpenChange}
        >
          <button type="button" className="ov2-rs-toolbar-btn lists">
            <UnorderedListOutlined /> Lists <DownOutlined style={{ fontSize: 10 }} />
          </button>
        </Dropdown>
        <Dropdown
          dropdownRender={() => <>{groupsPopover}</>}
          trigger={['click']}
          open={groupsOpen}
          onOpenChange={onGroupsOpenChange}
        >
          <button type="button" className="ov2-rs-toolbar-btn groups">
            <TeamOutlined /> Groups <DownOutlined style={{ fontSize: 10 }} />
          </button>
        </Dropdown>
      </div>
      {builderBanner}
      {appliedChips}
      <div className="ov2-rs-hint">
        {builderKind === 'group'
          ? 'Check legislators to include in the group. All checked recipients will receive one email together.'
          : builderKind === 'list'
            ? 'Check legislators to include in the list. Each checked recipient gets their own email.'
            : 'State house & senate members. Filter by state, then narrow by committee. Click + to add someone to To.'}
      </div>

      <div className="ov2-rs-table">
        <div className="ov2-rs-thead statelegislators">
          <span />
          <span>Name</span>
          <span>Committee</span>
          <span>Chamber</span>
          <span>State</span>
          <span>Party</span>
          <span />
        </div>
        <div className="ov2-rs-rows">
          {dir.isLoading ? (
            <div className="ov2-rs-empty">Loading state legislators…</div>
          ) : rows.length === 0 ? (
            <div className="ov2-rs-empty">
              No state legislators match. Try a different search or filter.
            </div>
          ) : (
            rows.map((row) => (
              <StateLegislatorTableRow
                key={row.id}
                row={row}
                targets={targets}
                builderKind={builderKind}
                builderHas={builderHas}
                onBuilderToggle={onBuilderToggle}
                onAdd={onAdd}
                onRemoveIndividual={onRemoveIndividual}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StateLegislatorTableRow({
  row,
  targets,
  builderKind,
  builderHas,
  onBuilderToggle,
  onAdd,
  onRemoveIndividual,
}: {
  row: StateLegislatorRow;
  targets: OutreachTarget[];
  builderKind: 'list' | 'group' | null;
  builderHas: (key: string) => boolean;
  onBuilderToggle: (r: OutreachRecipient) => void;
  onAdd: (r: OutreachRecipient) => void;
  onRemoveIndividual: (key: string) => void;
}) {
  const recipient = fromStateLegislator(row);
  const membership = membershipOf(targets, recipientKey(recipient));
  const tag = membership ? MEMBERSHIP_TAG[membership] : null;
  const groupChecked = builderKind === 'group' && builderHas(recipientKey(recipient));

  const committees = row.committees ?? [];
  const firstCommittee = committees[0];
  const chamber = humanizeStateChamber(row.chamber);

  return (
    <div
      className={
        'ov2-rs-row statelegislators' +
        (membership ? ' added' : '') +
        (groupChecked ? ' group-checked' : '')
      }
    >
      <span className="controls">
        <AddControl
          recipient={recipient}
          targets={targets}
          builderKind={builderKind}
          builderHas={builderHas}
          onBuilderToggle={onBuilderToggle}
          onAdd={onAdd}
          onRemoveIndividual={onRemoveIndividual}
        />
      </span>
      <span className="who">
        <div className="nm">{row.name}</div>
        <div className="sub">{stateLegislatorSubline(row)}</div>
      </span>
      <span
        className="ov2-rs-cell"
        title={committees.map((c) => c.name).join(', ') || undefined}
      >
        {firstCommittee
          ? committees.length > 1
            ? `${firstCommittee.name} +${committees.length - 1}`
            : firstCommittee.name
          : '—'}
      </span>
      <span className="ov2-rs-cell">{chamber || '—'}</span>
      <span className="ov2-rs-cell">{row.state}</span>
      <span>
        {row.party ? (
          <span className={'ov2-rs-pill' + (/^r/i.test(row.party) ? ' republican' : '')}>
            {row.party}
          </span>
        ) : (
          <span className="ov2-rs-cell">—</span>
        )}
      </span>
      {tag ? <span className={`ov2-rs-intag ${tag.cls}`}>{tag.text}</span> : <span />}
    </div>
  );
}

// =====================================================================
// Tab 2 — Client Contacts (derived view over clients + their people)
// =====================================================================

function ClientsTab({
  clients,
  targets,
  builderKind,
  builderHas,
  onBuilderToggle,
  onAdd,
  onRemoveIndividual,
  listsPopover,
  listsOpen,
  onListsOpenChange,
  groupsPopover,
  groupsOpen,
  onGroupsOpenChange,
  builderBanner,
  appliedChips,
}: {
  clients: Client[];
  targets: OutreachTarget[];
  builderKind: 'list' | 'group' | null;
  builderHas: (key: string) => boolean;
  onBuilderToggle: (r: OutreachRecipient) => void;
  onAdd: (r: OutreachRecipient) => void;
  onRemoveIndividual: (key: string) => void;
  listsPopover: ReactNode;
  listsOpen: boolean;
  onListsOpenChange: (open: boolean) => void;
  groupsPopover: ReactNode;
  groupsOpen: boolean;
  onGroupsOpenChange: (open: boolean) => void;
  builderBanner: ReactNode;
  appliedChips: ReactNode;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const peopleQueries = useQueries({
    queries: clients.map((client) => ({
      queryKey: ['ov2-rs-client-people', client.id],
      queryFn: async () => (await api.get<ClientPerson[]>(`/api/clients/${client.id}/people`)).data,
      staleTime: 60_000,
    })),
  });
  const peopleByClient = useMemo(() => {
    const map = new Map<string, ClientPerson[]>();
    clients.forEach((client, i) => map.set(client.id, peopleQueries[i]?.data ?? []));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, ...peopleQueries.map((query) => query.data)]);
  const peopleLoading = peopleQueries.some((query) => query.isLoading);

  const favorites = useQuery<FavoriteRow[]>({
    queryKey: ['directory-favorites'],
    queryFn: async () => (await api.get<FavoriteRow[]>('/api/directory/favorites')).data,
  });
  const favSet = useMemo(
    () => new Set((favorites.data ?? []).map((f) => f.directoryContactId)),
    [favorites.data],
  );
  const toggleFavorite = useMutation({
    mutationFn: async (vars: { id: string; name: string; favorited: boolean }) =>
      vars.favorited
        ? (await api.delete(`/api/directory/contacts/${encodeURIComponent(vars.id)}/favorite`)).data
        : (
            await api.post(`/api/directory/contacts/${encodeURIComponent(vars.id)}/favorite`, {
              directoryContactName: vars.name,
            })
          ).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ['directory-favorites'] }),
  });

  const qq = search.trim().toLowerCase();
  const visible = clients.filter((client) => {
    const people = peopleByClient.get(client.id) ?? [];
    if (favOnly && !people.some((p) => favSet.has(`clientperson:${p.id}`))) return false;
    if (!qq) return true;
    return (
      client.name.toLowerCase().includes(qq) ||
      clientIndustry(client).toLowerCase().includes(qq) ||
      people.some(
        (p) => p.name.toLowerCase().includes(qq) || (p.email ?? '').toLowerCase().includes(qq),
      )
    );
  });
  // Searching or filtering by favorites implies you want to see the matching
  // contacts, not just the client shells — expand them automatically.
  const autoExpand = Boolean(qq) || favOnly;

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <div className="ov2-rs-toolbar">
        <Input
          className="search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search clients and contacts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className={'ov2-rs-toolbar-btn' + (favOnly ? ' fav-on' : '')}
          onClick={() => setFavOnly((f) => !f)}
        >
          {favOnly ? <StarFilled /> : <StarOutlined />} Favorites
        </button>
        <Dropdown
          dropdownRender={() => <>{listsPopover}</>}
          trigger={['click']}
          open={listsOpen}
          onOpenChange={onListsOpenChange}
        >
          <button type="button" className="ov2-rs-toolbar-btn lists">
            <UnorderedListOutlined /> Lists <DownOutlined style={{ fontSize: 10 }} />
          </button>
        </Dropdown>
        <Dropdown
          dropdownRender={() => <>{groupsPopover}</>}
          trigger={['click']}
          open={groupsOpen}
          onOpenChange={onGroupsOpenChange}
        >
          <button type="button" className="ov2-rs-toolbar-btn groups">
            <TeamOutlined /> Groups <DownOutlined style={{ fontSize: 10 }} />
          </button>
        </Dropdown>
      </div>
      {builderBanner}
      {appliedChips}
      <div className="ov2-rs-hint">
        {builderKind === 'group'
          ? 'Check contacts to include in the group. All checked recipients will receive one email together.'
          : builderKind === 'list'
            ? 'Check contacts to include them in the list. Each checked recipient gets their own email.'
            : 'Showing all clients A–Z. Use the caret to expand contacts. Click + to add a contact to To.'}
      </div>

      <div className="ov2-rs-table">
        <div className="ov2-rs-thead clients">
          <span />
          <span>Client / Contact</span>
          <span>Title / Role</span>
          <span>Email</span>
          <span />
        </div>
        <div className="ov2-rs-rows">
          {visible.length === 0 ? (
            <div className="ov2-rs-empty">
              {peopleLoading
                ? 'Loading client contacts…'
                : favOnly
                  ? 'No favorited client contacts yet. Star contacts to find them faster.'
                  : 'No clients match. Try a different search.'}
            </div>
          ) : (
            visible
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((client) => {
                const people = peopleByClient.get(client.id) ?? [];
                const isOpen = autoExpand || expanded.has(client.id);
                const shownPeople = favOnly
                  ? people.filter((p) => favSet.has(`clientperson:${p.id}`))
                  : people;
                return (
                  <ClientRows
                    key={client.id}
                    client={client}
                    people={shownPeople}
                    totalPeople={people.length}
                    loading={peopleLoading}
                    open={isOpen}
                    onToggleExpand={() => toggleExpand(client.id)}
                    targets={targets}
                    favSet={favSet}
                    onToggleFavorite={(p) =>
                      toggleFavorite.mutate({
                        id: `clientperson:${p.id}`,
                        name: p.name,
                        favorited: favSet.has(`clientperson:${p.id}`),
                      })
                    }
                    builderKind={builderKind}
                    builderHas={builderHas}
                    onBuilderToggle={onBuilderToggle}
                    onAdd={onAdd}
                    onRemoveIndividual={onRemoveIndividual}
                  />
                );
              })
          )}
        </div>
      </div>
    </div>
  );
}

function ClientRows({
  client,
  people,
  totalPeople,
  loading,
  open,
  onToggleExpand,
  targets,
  favSet,
  onToggleFavorite,
  builderKind,
  builderHas,
  onBuilderToggle,
  onAdd,
  onRemoveIndividual,
}: {
  client: Client;
  people: ClientPerson[];
  totalPeople: number;
  loading: boolean;
  open: boolean;
  onToggleExpand: () => void;
  targets: OutreachTarget[];
  favSet: Set<string>;
  onToggleFavorite: (p: ClientPerson) => void;
  builderKind: 'list' | 'group' | null;
  builderHas: (key: string) => boolean;
  onBuilderToggle: (r: OutreachRecipient) => void;
  onAdd: (r: OutreachRecipient) => void;
  onRemoveIndividual: (key: string) => void;
}) {
  return (
    <>
      <div className="ov2-rs-row clients">
        <span className="controls">
          <button
            type="button"
            className="ov2-rs-caret"
            onClick={onToggleExpand}
            aria-label={open ? 'Collapse contacts' : 'Expand contacts'}
          >
            {open ? <DownOutlined /> : <RightOutlined />}
          </button>
        </span>
        <span className="who">
          <div className="nm">{client.name}</div>
          <div className="sub">
            {clientIndustry(client)} · {loading ? '…' : totalPeople}{' '}
            {totalPeople === 1 ? 'contact' : 'contacts'}
          </div>
        </span>
        <span />
        <span />
        <span className="ov2-rs-client-badge">Client</span>
      </div>
      {open &&
        (people.length === 0 ? (
          <div className="ov2-rs-row clients sub">
            <span />
            <span className="who">
              <div className="sub">
                {loading ? 'Loading contacts…' : 'No key persons on this client yet.'}
              </div>
            </span>
            <span />
            <span />
            <span />
          </div>
        ) : (
          people.map((person) => {
            const recipient = clientPersonRecipient(client, person);
            const membership = membershipOf(targets, recipientKey(recipient));
            const tag = membership ? MEMBERSHIP_TAG[membership] : null;
            const favId = `clientperson:${person.id}`;
            const pGroupChecked = builderKind === 'group' && builderHas(recipientKey(recipient));
            return (
              <div
                key={person.id}
                className={
                  'ov2-rs-row clients sub' +
                  (membership ? ' added' : '') +
                  (pGroupChecked ? ' group-checked' : '')
                }
              >
                <span className="controls">
                  <AddControl
                    recipient={recipient}
                    targets={targets}
                    builderKind={builderKind}
                    builderHas={builderHas}
                    onBuilderToggle={onBuilderToggle}
                    onAdd={onAdd}
                    onRemoveIndividual={onRemoveIndividual}
                  />
                  <button
                    type="button"
                    className={'ov2-rs-star' + (favSet.has(favId) ? ' on' : '')}
                    onClick={() => onToggleFavorite(person)}
                    aria-label={favSet.has(favId) ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    {favSet.has(favId) ? <StarFilled /> : <StarOutlined />}
                  </button>
                </span>
                <span className="who">
                  <div className="nm">{person.name}</div>
                  <div className="sub">{person.title || '—'}</div>
                </span>
                <span className="ov2-rs-cell">{person.role || '—'}</span>
                <span className="ov2-rs-cell" title={person.email ?? undefined}>
                  {person.email || '—'}
                </span>
                {tag ? <span className={`ov2-rs-intag ${tag.cls}`}>{tag.text}</span> : <span />}
              </div>
            );
          })
        ))}
    </>
  );
}

// =====================================================================
// Tab 3 — Manual Add
// =====================================================================

function ManualTab({
  onAdd,
  builderKind,
  builderBanner,
}: {
  onAdd: (r: OutreachRecipient) => void;
  builderKind: 'list' | 'group' | null;
  builderBanner: ReactNode;
}) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const valid = first.trim().length > 0 && last.trim().length > 0 && EMAIL_RE.test(email.trim());

  const add = () => {
    if (!valid) return;
    onAdd({
      id: `manual:${email.trim().toLowerCase()}`,
      name: `${first.trim()} ${last.trim()}`,
      email: email.trim(),
      relevanceReason: 'Manually added',
    });
    setFirst('');
    setLast('');
    setEmail('');
  };

  return (
    <div>
      {builderBanner}
      <div className="ov2-rs-hint">
        {builderKind
          ? `Add a recipient who isn't in the directory — they'll be picked into your new ${builderKind}. First name, last name, and email are all required.`
          : "Add a recipient who isn't in the directory. First name, last name, and email are all required."}
      </div>
      <div className="ov2-rs-manual">
        <Input
          style={{ flex: '0 1 160px' }}
          placeholder="First name"
          value={first}
          onChange={(e) => setFirst(e.target.value)}
          onPressEnter={add}
        />
        <Input
          style={{ flex: '0 1 160px' }}
          placeholder="Last name"
          value={last}
          onChange={(e) => setLast(e.target.value)}
          onPressEnter={add}
        />
        <Input
          style={{ flex: '0 1 260px' }}
          type="email"
          prefix={<UserOutlined />}
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onPressEnter={add}
        />
        <Button disabled={!valid} onClick={add}>
          {builderKind ? `Add to ${builderKind}` : 'Add'}
        </Button>
      </div>
    </div>
  );
}
