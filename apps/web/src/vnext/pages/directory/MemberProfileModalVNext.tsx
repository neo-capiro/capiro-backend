import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { decodeHtmlEntities } from '../../../lib/html-entities.js';
import {
  FEC_FALLBACK_DISCLAIMER,
  formatNewsDate,
  formatNoteDate,
  formatUsd,
  genderLabel,
  noteAuthor,
  partyLabel,
  partyShortCode,
  romanNumeral,
  stateDistrict,
  yearFromDate,
  type MemberFecSummary,
  type MemberNewsPayload,
  type MemberRepresentationSummary,
} from '../../../pages/directory/directory-format.js';
import type { DirectoryContactNote, DirectoryEntry } from '../../../pages/directory/directoryData.js';
import { CapiroButton, CapiroIconButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroCopyIcon, type CapiroIconProps } from '../../components/icons/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { CapiroTabs } from '../../components/menus/index.js';
import { CapiroModal } from '../../components/overlays/index.js';

/**
 * Member profile modal — Directory vNext (Congressional Staff).
 *
 * Tab-for-tab re-skin of the canonical `DirectoryMemberProfileModal`
 * (`src/pages/directory/`, Ant Design): the same seven tabs (Contact, Staff,
 * Bio, Committees, Leadership, Links, News), the same Notes/Representation/FEC
 * side panels, the same four `/api/directory/contacts/:id/*` endpoints with
 * the same query keys, and the same empty/loading language — only the
 * presentation moves to vNext primitives and `--capiro-*` tokens (established
 * re-skin pattern; see `vnext/meri/MeriMemoryTab.tsx`).
 *
 * It exists because no legacy UI (antd, `theme.css`) may render on
 * os.capiro.ai. Pure formatters and payload contracts are shared with the
 * canonical modal via `directory-format.ts`, so the two surfaces can restyle
 * independently without drifting on what the data means.
 *
 * Two deliberate deltas from the antd original, both kit-anatomy driven:
 *  - the member's name lives in the modal header (`CapiroModal` title), not
 *    duplicated as a second heading inside the hero;
 *  - the kit toast set is success|error only, so the "No email on this
 *    profile." advisory that antd showed as `message.warning` surfaces on the
 *    error tone (same words).
 */

/* File-local glyphs, matching the semantics of the antd icons the canonical
 * modal uses. The shared set (`components/icons`) has no mail/phone/send/link
 * entry, and per the StrategiesModalShell precedent a shared file is not
 * grown from inside one module's pass — these mirror its stroke convention
 * (24×24 viewBox, currentColor, 1.75 stroke, em-sized, aria-hidden). */
function LocalGlyph({ size = 1, children }: CapiroIconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={`${size}em`}
      height={`${size}em`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="capiro-icon"
      style={{ flexShrink: 0, verticalAlign: '-0.125em' }}
    >
      {children}
    </svg>
  );
}

function MailGlyph(props: CapiroIconProps) {
  return (
    <LocalGlyph {...props}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </LocalGlyph>
  );
}

function PhoneGlyph(props: CapiroIconProps) {
  return (
    <LocalGlyph {...props}>
      <path d="M5.5 4h3l1.5 4-2 1.5a12.5 12.5 0 0 0 6.5 6.5L16 14l4 1.5v3a2 2 0 0 1-2 2A14.5 14.5 0 0 1 3.5 6a2 2 0 0 1 2-2Z" />
    </LocalGlyph>
  );
}

function SendGlyph(props: CapiroIconProps) {
  return (
    <LocalGlyph {...props}>
      <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5 21 3Z" />
    </LocalGlyph>
  );
}

function LinkGlyph(props: CapiroIconProps) {
  return (
    <LocalGlyph {...props}>
      <path d="M10 14a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 5.9" />
      <path d="M14 10a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 18.1" />
    </LocalGlyph>
  );
}

/** D reads on the info (blue) tone, R on the danger (red) tone, I neutral. */
function partyTone(code: string): CapiroBadgeTone {
  return code === 'D' ? 'info' : code === 'R' ? 'danger' : 'neutral';
}

const TAB_ITEMS = [
  { id: 'contact', label: 'Contact' },
  { id: 'staff', label: 'Staff' },
  { id: 'bio', label: 'Bio' },
  { id: 'committees', label: 'Committees' },
  { id: 'leadership', label: 'Leadership' },
  { id: 'links', label: 'Links' },
  { id: 'news', label: 'News' },
] as const;

export function MemberProfileModalVNext({
  entry,
  open,
  onClose,
}: {
  entry: DirectoryEntry | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!entry) return null;
  return (
    // The wrapper carries the scope class the width override in directory.css
    // hangs off; the overlay inside is position:fixed, so the empty in-flow div
    // costs no layout. Keyed by member so reopening on someone else starts
    // clean — the same effect canonical got from antd's `destroyOnClose`.
    <div className="capiro-dirprofile">
      <CapiroModal open={open} title={entry.fullName} onClose={onClose}>
        <MemberProfileBody key={entry.id} entry={entry} />
      </CapiroModal>
    </div>
  );
}

function MemberProfileBody({ entry }: { entry: DirectoryEntry }) {
  const toast = useCapiroToast();
  const [activeTab, setActiveTab] = useState<string>('contact');
  // antd Tabs mounts a pane on first activation and keeps it mounted after;
  // the News fetch firing only once the tab is opened is behaviour worth
  // keeping, as is a half-typed note surviving a trip to another tab.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(['contact']));

  function openTab(id: string) {
    setActiveTab(id);
    setVisited((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
  }

  async function copyContact(value: string, label: string) {
    if (!value) {
      toast.error(`No ${label.toLowerCase()} on this profile.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${label.toLowerCase()}.`);
    } catch {
      toast.error('Clipboard copy failed in this browser context.');
    }
  }

  const partyShort = partyShortCode(entry.party);
  const seat = stateDistrict(entry);

  return (
    <div className="capiro-dirprofile__body">
      <p className="capiro-dirprofile__escape">
        <Link className="capiro-dirprofile__escape-link" to={`/directory/members/${encodeURIComponent(entry.id)}`}>
          Open full profile ↗
        </Link>
      </p>

      <section className="capiro-dirprofile__hero">
        {/* Decorative: the name this mark would announce is the modal's own
            heading directly above it. */}
        <IdentityMark
          kind="person"
          size="lg"
          name={entry.memberName || entry.fullName}
          imageUrl={entry.photoUrl || null}
          aria-hidden="true"
        />
        <div className="capiro-dirprofile__hero-main">
          <div className="capiro-dirprofile__pills">
            <CapiroBadge>{entry.chamber || 'Member'}</CapiroBadge>
            {partyShort ? (
              <CapiroBadge tone={partyTone(partyShort)} title={partyLabel(entry.party)}>
                {partyShort}
              </CapiroBadge>
            ) : null}
            {seat ? <CapiroBadge>{seat}</CapiroBadge> : null}
          </div>
          <p className="capiro-dirprofile__role">{entry.title}</p>
          <p className="capiro-dirprofile__serving">
            Serving in {entry.chamber} since {yearFromDate(entry.servingSince)}
          </p>
        </div>
        <div className="capiro-dirprofile__hero-actions">
          <CapiroIconButton
            label="Copy email"
            icon={<MailGlyph />}
            onClick={() => void copyContact(entry.email, 'Email')}
          />
          <CapiroIconButton
            label="Copy phone"
            icon={<PhoneGlyph />}
            onClick={() => void copyContact(entry.phone, 'Phone')}
          />
          {entry.contactFormUrl ? (
            <a className="capiro-dirprofile__linkbtn" href={entry.contactFormUrl} target="_blank" rel="noreferrer">
              Contact Form
            </a>
          ) : null}
        </div>
      </section>

      <CapiroTabs items={TAB_ITEMS} activeId={activeTab} onChange={openTab} label="Member profile sections" />

      {TAB_ITEMS.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          aria-label={tab.label}
          className="capiro-dirprofile__panel"
          hidden={activeTab !== tab.id}
        >
          {visited.has(tab.id) ? renderTab(tab.id, entry, copyContact) : null}
        </div>
      ))}
    </div>
  );
}

function renderTab(
  id: string,
  entry: DirectoryEntry,
  copyContact: (value: string, label: string) => Promise<void>,
) {
  switch (id) {
    case 'contact':
      return <ContactTab entry={entry} onCopy={copyContact} />;
    case 'staff':
      return <StaffTab entry={entry} onCopy={copyContact} />;
    case 'bio':
      return <BioTab entry={entry} />;
    case 'committees':
      return <CommitteesTab entry={entry} />;
    case 'leadership':
      return <LeadershipTab entry={entry} />;
    case 'links':
      return <LinksTab entry={entry} />;
    case 'news':
      return <NewsPanel entry={entry} />;
    default:
      return null;
  }
}

/** vNext rendering of canonical's `CopyableTextRow`: text plus a copy control. */
function CopyRow({
  label,
  value,
  emptyText,
  onCopy,
}: {
  label: string;
  value: string;
  emptyText: string;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const copyValue = value.trim();
  return (
    <span className="capiro-dirprofile__copyrow">
      <span className="capiro-dirprofile__line">
        {label}: {copyValue || emptyText}
      </span>
      {copyValue ? (
        <button
          type="button"
          className="capiro-dirprofile__copybtn"
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
          onClick={() => void onCopy(copyValue, label)}
        >
          <CapiroCopyIcon />
        </button>
      ) : null}
    </span>
  );
}

/* ── Tab 1: Contact ──────────────────────────────────────────────────────── */

function ContactTab({
  entry,
  onCopy,
}: {
  entry: DirectoryEntry;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  return (
    <div className="capiro-dirprofile__columns">
      <div className="capiro-dirprofile__col-main">
        <h3 className="capiro-dirprofile__heading">Contact</h3>
        <div className="capiro-dirprofile__contact-grid">
          <div>
            <p className="capiro-dirprofile__block-label">Main Office</p>
            <p className="capiro-dirprofile__line">
              {entry.officeLocation || 'No public office address listed'}
            </p>
            <div className="capiro-dirprofile__contact-lines">
              <CopyRow label="Phone" value={entry.phone} emptyText="N/A" onCopy={onCopy} />
              <span className="capiro-dirprofile__line">Fax: {entry.fax || 'N/A'}</span>
              <CopyRow label="Email" value={entry.email} emptyText="No public email listed" onCopy={onCopy} />
            </div>
          </div>
          <div>
            <p className="capiro-dirprofile__block-label">Official Links</p>
            <div className="capiro-dirprofile__linklist">
              {entry.officialLinks.slice(0, 8).map((link) => (
                <a
                  key={`${link.type}-${link.url}`}
                  className="capiro-dirprofile__link"
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </div>

        <h3 className="capiro-dirprofile__heading">Office Locations</h3>
        <div className="capiro-dirprofile__addresses">
          {entry.addresses.map((address) => (
            <div key={address.id} className="capiro-dirprofile__address">
              <p className="capiro-dirprofile__block-label">{address.title || 'Office'}</p>
              <p className="capiro-dirprofile__line">
                {[address.address1, address.address2, address.city, address.state, address.zip]
                  .filter(Boolean)
                  .join(', ')}
              </p>
              <p className="capiro-dirprofile__meta">
                {address.phone || 'No phone'} {address.fax ? `| Fax ${address.fax}` : ''}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="capiro-dirprofile__col-side">
        <section className="capiro-dirprofile-card">
          <p className="capiro-dirprofile-card__title">Snapshot</p>
          <div className="capiro-dirprofile-card__rows">
            <p className="capiro-dirprofile__line">
              Party: {entry.partyName} ({entry.party})
            </p>
            <p className="capiro-dirprofile__line">Gender: {genderLabel(entry.gender)}</p>
            <p className="capiro-dirprofile__line">Region: {entry.region}</p>
            {entry.senateClass ? (
              <p className="capiro-dirprofile__line">Senate class: {romanNumeral(entry.senateClass)}</p>
            ) : null}
            {entry.outgoingStatus ? (
              <p className="capiro-dirprofile__line capiro-dirprofile__line--warning">{entry.outgoingStatus}</p>
            ) : null}
            <p className="capiro-dirprofile__line">Last source update: {entry.lastTouchpoint}</p>
          </div>
        </section>

        {entry.topIssues.length > 0 ? (
          <section className="capiro-dirprofile-card">
            <p className="capiro-dirprofile-card__title">Top issues by staff coverage</p>
            <div className="capiro-dirprofile__badges">
              {entry.topIssues.map((issue) => (
                <CapiroBadge key={issue.issue} tone="info">
                  {issue.issue} · {issue.stafferCount}
                </CapiroBadge>
              ))}
            </div>
            <p className="capiro-dirprofile__fineprint">
              Number of this office's staffers tagged to each issue — a proxy for where the office
              invests, not a complete policy position.
            </p>
          </section>
        ) : null}

        <NotesPanel entry={entry} />
        <RepresentationPanel entry={entry} />
        <FecPanel entry={entry} />
      </div>
    </div>
  );
}

/* ── Tab 2: Staff ────────────────────────────────────────────────────────── */

/** vNext rendering of canonical's `StaffContactValue`: icon, value, copy. */
function StaffContact({
  icon,
  label,
  value,
  emptyText,
  onCopy,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  emptyText: string;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const copyValue = value.trim();
  return (
    <span className="capiro-dirprofile__copyrow" title={copyValue ? `Copy ${label}` : emptyText}>
      <span className={`capiro-dirprofile__line${copyValue ? '' : ' capiro-dirprofile__line--muted'}`}>
        {icon} {copyValue || emptyText}
      </span>
      {copyValue ? (
        <button
          type="button"
          className="capiro-dirprofile__copybtn"
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
          onClick={() => void onCopy(copyValue, label)}
        >
          <CapiroCopyIcon />
        </button>
      ) : null}
    </span>
  );
}

function StaffTab({
  entry,
  onCopy,
}: {
  entry: DirectoryEntry;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  return (
    <div>
      <h3 className="capiro-dirprofile__heading">{entry.fullName}'s Staff</h3>
      {entry.staff.length > 0 ? (
        <div className="capiro-dirprofile-staff">
          <div className="capiro-dirprofile-staff__header" aria-hidden="true">
            <span>Staffer</span>
            <span>Roles &amp; Issue Areas</span>
            <span>Phone</span>
            <span>Email</span>
          </div>
          {entry.staff.map((staffer) => (
            <div key={staffer.id} className="capiro-dirprofile-staff__row">
              <span className="capiro-dirprofile-staff__person">
                <Link
                  className="capiro-dirprofile__link"
                  to={`/directory/staff/${encodeURIComponent(staffer.id)}`}
                >
                  {staffer.fullName}
                </Link>
                <span className="capiro-dirprofile__meta">{staffer.title}</span>
              </span>
              <span className="capiro-dirprofile__badges">
                {staffer.roles.slice(0, 2).map((role) => (
                  <CapiroBadge key={`${staffer.id}-${role}`}>{role}</CapiroBadge>
                ))}
                {staffer.issueAreas.slice(0, 3).map((issue) => (
                  <CapiroBadge key={`${staffer.id}-${issue}`} tone="info">
                    {issue}
                  </CapiroBadge>
                ))}
              </span>
              {/* A staffer with no direct line is reachable through the office
                  main line, exactly as canonical falls back. */}
              <StaffContact
                icon={<PhoneGlyph />}
                label="Phone"
                value={staffer.phone || entry.phone}
                emptyText="None listed"
                onCopy={onCopy}
              />
              <StaffContact
                icon={<MailGlyph />}
                label="Email"
                value={staffer.email}
                emptyText="None listed"
                onCopy={onCopy}
              />
            </div>
          ))}
        </div>
      ) : (
        <CapiroEmptyState title="No staff records in source snapshot" />
      )}
    </div>
  );
}

/* ── Tab 3: Bio ──────────────────────────────────────────────────────────── */

function BioTab({ entry }: { entry: DirectoryEntry }) {
  const fields = [
    ['Born', entry.bio.dob],
    ['Birthplace', entry.bio.birthplace],
    ['Hometown', entry.bio.hometown],
    ['Occupation', entry.bio.occupation],
    ['Education', entry.bio.education],
    ['Military Service', entry.bio.military],
    ['Political Family', entry.bio.relatives],
    ['Race', entry.bio.race],
    ['Religion', entry.bio.religion],
    ['Pronunciation', entry.bio.pronunciation],
  ].filter(([, value]) => value);

  return (
    <div className="capiro-dirprofile__stack">
      {entry.bio.narrative ? (
        <div className="capiro-dirprofile__biocard capiro-dirprofile__biocard--narrative">
          <p className="capiro-dirprofile__meta">Biography</p>
          <p className="capiro-dirprofile__line capiro-dirprofile__line--preline">{entry.bio.narrative}</p>
        </div>
      ) : null}
      {fields.length > 0 ? (
        <div className="capiro-dirprofile__biogrid">
          {fields.map(([label, value]) => (
            <div key={label} className="capiro-dirprofile__biocard">
              <p className="capiro-dirprofile__meta">{label}</p>
              <p className="capiro-dirprofile__line">{value}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Tab 4: Committees ───────────────────────────────────────────────────── */

function CommitteesTab({ entry }: { entry: DirectoryEntry }) {
  return (
    <div className="capiro-dirprofile__stack">
      {entry.committeeLeadership.length > 0 ? (
        <div>
          <p className="capiro-dirprofile__block-label">Leadership roles</p>
          <div className="capiro-dirprofile__badges">
            {entry.committeeLeadership.map((role) => (
              // Warning tone is the token set's rendering of canonical's gold tag.
              <CapiroBadge key={role} tone="warning">
                {role}
              </CapiroBadge>
            ))}
          </div>
        </div>
      ) : null}
      <div>
        {entry.committeeLeadership.length > 0 ? (
          <p className="capiro-dirprofile__block-label">All committees</p>
        ) : null}
        {entry.committees.length > 0 ? (
          <div className="capiro-dirprofile__badges">
            {entry.committees.map((committee) => (
              <CapiroBadge key={committee}>{committee}</CapiroBadge>
            ))}
          </div>
        ) : (
          <CapiroEmptyState title="No committee data in source snapshot" />
        )}
      </div>
    </div>
  );
}

/* ── Tab 5: Leadership ───────────────────────────────────────────────────── */

function LeadershipTab({ entry }: { entry: DirectoryEntry }) {
  return (
    <div className="capiro-dirprofile__stack">
      {entry.leadershipPositions.length > 0 ? (
        entry.leadershipPositions.map((position) => (
          <div key={position} className="capiro-dirprofile__biocard">
            <p className="capiro-dirprofile__block-label">{position}</p>
          </div>
        ))
      ) : (
        <CapiroEmptyState title="No current leadership roles in source snapshot" />
      )}
    </div>
  );
}

/* ── Tab 6: Links ────────────────────────────────────────────────────────── */

function LinksTab({ entry }: { entry: DirectoryEntry }) {
  return (
    <div className="capiro-dirprofile__linkgrid">
      {entry.officialLinks.map((link) => (
        <a
          key={`${link.type}-${link.url}`}
          className="capiro-dirprofile__link"
          href={link.url}
          target="_blank"
          rel="noreferrer"
        >
          <LinkGlyph /> {link.label}
        </a>
      ))}
    </div>
  );
}

/* ── Notes side panel ────────────────────────────────────────────────────── */

const NOTE_MAX_LENGTH = 4000;

function NotesPanel({ entry }: { entry: DirectoryEntry }) {
  const toast = useCapiroToast();
  const api = useApi();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');

  const notes = useQuery<DirectoryContactNote[]>({
    queryKey: ['directory-contact-notes', entry.id],
    queryFn: async () =>
      (await api.get<DirectoryContactNote[]>(`/api/directory/contacts/${encodeURIComponent(entry.id)}/notes`))
        .data,
    staleTime: 15_000,
  });

  const createNote = useMutation({
    mutationFn: async () =>
      (
        await api.post<DirectoryContactNote>(`/api/directory/contacts/${encodeURIComponent(entry.id)}/notes`, {
          body,
          directoryContactName: entry.fullName,
        })
      ).data,
    onSuccess: async () => {
      setBody('');
      await queryClient.invalidateQueries({ queryKey: ['directory-contact-notes', entry.id] });
      toast.success('Note added.');
    },
    onError: (error) => {
      toast.error((error as Error).message || 'Could not add note.');
    },
  });

  const trimmedBody = body.trim();

  return (
    <section className="capiro-dirprofile-card">
      <p className="capiro-dirprofile-card__title">Notes</p>
      <textarea
        className="capiro-dirprofile__textarea"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Add a tenant-visible note"
        aria-label="Add a tenant-visible note"
        maxLength={NOTE_MAX_LENGTH}
        rows={3}
      />
      <p className="capiro-dirprofile__count" aria-hidden="true">
        {body.length} / {NOTE_MAX_LENGTH}
      </p>
      <CapiroButton
        variant="primary"
        size="compact"
        leadingIcon={<SendGlyph />}
        loading={createNote.isPending}
        disabled={!trimmedBody}
        onClick={() => createNote.mutate()}
      >
        Add note
      </CapiroButton>

      {notes.isLoading ? <CapiroSkeleton height={40} /> : null}

      {!notes.isLoading && (notes.data?.length ?? 0) === 0 ? (
        <CapiroEmptyState title="No notes yet" />
      ) : null}

      <div className="capiro-dirprofile__list">
        {(notes.data ?? []).map((note) => (
          <div key={note.id} className="capiro-dirprofile__list-item">
            <p className="capiro-dirprofile__line">{note.body}</p>
            <p className="capiro-dirprofile__meta">
              {formatNoteDate(note.createdAt)} by {noteAuthor(note)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Representation side panel ───────────────────────────────────────────── */

/**
 * District Impact Engine — "Represents client facilities": every client
 * (tenant-wide) with a facility in this member's district. Deterministic
 * (bioguideId + district join), NOT name-matched like the FEC panel, so no
 * approximate-match disclaimer is needed. Hidden entirely when empty, exactly
 * as canonical hides it.
 */
function RepresentationPanel({ entry }: { entry: DirectoryEntry }) {
  const api = useApi();
  const query = useQuery<MemberRepresentationSummary>({
    queryKey: ['directory-contact-representation', entry.id],
    queryFn: async () =>
      (
        await api.get<MemberRepresentationSummary>(
          `/api/directory/contacts/${encodeURIComponent(entry.id)}/representation-summary`,
        )
      ).data,
    staleTime: 5 * 60_000,
  });
  const clients = query.data?.clients ?? [];
  if (!query.isLoading && clients.length === 0) return null;
  return (
    <section className="capiro-dirprofile-card">
      <p className="capiro-dirprofile-card__title">Represents client facilities</p>
      {query.isLoading ? (
        <CapiroSkeleton height={40} />
      ) : (
        <div className="capiro-dirprofile__list">
          {clients.map((client) => (
            <div key={client.clientId} className="capiro-dirprofile__list-item">
              <p className="capiro-dirprofile__block-label">{client.clientName}</p>
              <div className="capiro-dirprofile__badges">
                {client.facilities.map((facility) => (
                  <CapiroBadge key={facility.id}>{facility.name}</CapiroBadge>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── FEC side panel ──────────────────────────────────────────────────────── */

/**
 * Member-scoped FEC relationship: contributions to this member from the
 * tenant's mapped clients' employers. APPROXIMATE (name-matched) — labelled as
 * such — and wrapped in the API-provided compliance disclaimer. Read-only.
 */
function FecPanel({ entry }: { entry: DirectoryEntry }) {
  const api = useApi();
  const query = useQuery<MemberFecSummary>({
    queryKey: ['directory-contact-fec', entry.id],
    queryFn: async () =>
      (await api.get<MemberFecSummary>(`/api/directory/contacts/${encodeURIComponent(entry.id)}/fec-summary`))
        .data,
    staleTime: 5 * 60_000,
  });

  const data = query.data;
  const hasData = (data?.clients.length ?? 0) > 0;

  return (
    <section className="capiro-dirprofile-card">
      <p className="capiro-dirprofile-card__title">
        Client FEC relationship <CapiroBadge>approximate · name-matched</CapiroBadge>
      </p>
      {query.isLoading ? (
        <CapiroSkeleton height={40} />
      ) : hasData ? (
        <>
          <p className="capiro-dirprofile__meta">
            {formatUsd(data!.summary.totalAmount)} across {data!.summary.contributionCount} contribution
            {data!.summary.contributionCount !== 1 ? 's' : ''} from {data!.summary.clientCount} mapped client
            {data!.summary.clientCount !== 1 ? 's' : ''}.
          </p>
          <div className="capiro-dirprofile__list">
            {data!.clients.map((client) => (
              <div key={client.clientId} className="capiro-dirprofile__list-item">
                <p className="capiro-dirprofile__split">
                  <span className="capiro-dirprofile__block-label">{client.clientName}</span>
                  <CapiroBadge tone="success">{formatUsd(client.totalAmount)}</CapiroBadge>
                </p>
                <p className="capiro-dirprofile__meta">
                  via employer {client.mappedEmployer} · {client.contributionCount} contribution
                  {client.contributionCount !== 1 ? 's' : ''}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <CapiroEmptyState title="No contributions from your mapped clients matched this member." />
      )}
      <p className="capiro-dirprofile__fineprint">{data?.disclaimer ?? FEC_FALLBACK_DISCLAIMER}</p>
    </section>
  );
}

/* ── Tab 7: News ─────────────────────────────────────────────────────────── */

/**
 * News tab: the member's recent press releases, pre-ingested into
 * member_press_item every ~3 days by the sync-member-press job (no live fetch
 * on profile view). Each item shows title + date + the feed's summary and
 * links out to the full release.
 */
function NewsPanel({ entry }: { entry: DirectoryEntry }) {
  const api = useApi();

  const query = useQuery<MemberNewsPayload>({
    queryKey: ['directory-contact-news', entry.id],
    queryFn: async () =>
      (await api.get<MemberNewsPayload>(`/api/directory/contacts/${encodeURIComponent(entry.id)}/news`)).data,
    staleTime: 5 * 60_000,
  });

  const data = query.data;
  const items = data?.items ?? [];

  const links = (
    <div className="capiro-dirprofile__linkbtn-row">
      {data?.newsPressUrl ? (
        <a className="capiro-dirprofile__linkbtn" href={data.newsPressUrl} target="_blank" rel="noreferrer">
          <LinkGlyph /> Press page
        </a>
      ) : null}
      {data?.rssFeedUrl ? (
        <a className="capiro-dirprofile__linkbtn" href={data.rssFeedUrl} target="_blank" rel="noreferrer">
          <LinkGlyph /> RSS feed
        </a>
      ) : null}
    </div>
  );

  if (query.isLoading) {
    return <CapiroSkeleton height={64} />;
  }

  if (items.length === 0) {
    return (
      <>
        {links}
        <CapiroEmptyState
          title={
            data?.feedError === 'no_feed' && !data?.newsPressUrl
              ? 'No news feed or press page on file for this member.'
              : 'No recent press releases.'
          }
          action={
            data?.newsPressUrl ? (
              <a
                className="capiro-dirprofile__linkbtn capiro-dirprofile__linkbtn--primary"
                href={data.newsPressUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open press page
              </a>
            ) : undefined
          }
        />
      </>
    );
  }

  return (
    <>
      {links}
      <div className="capiro-dirprofile__list">
        {items.map((item) => (
          <div key={item.id} className="capiro-dirprofile-news__item">
            <a
              className="capiro-dirprofile__link"
              href={item.link || data?.newsPressUrl || undefined}
              target="_blank"
              rel="noreferrer"
            >
              {decodeHtmlEntities(item.title)}
            </a>
            {item.publishedAt ? (
              <p className="capiro-dirprofile__meta">{formatNewsDate(item.publishedAt)}</p>
            ) : null}
            {item.summary ? (
              <p className="capiro-dirprofile__line capiro-dirprofile-news__summary">
                {decodeHtmlEntities(item.summary)}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {data?.lastSyncedAt ? (
        <p className="capiro-dirprofile__fineprint">Updated {formatNewsDate(data.lastSyncedAt)}</p>
      ) : null}
    </>
  );
}
