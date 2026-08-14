import { useState } from 'react';
import {
  App,
  Avatar,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Modal,
  Row,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { LinkOutlined, MailOutlined, PhoneOutlined, SendOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { decodeHtmlEntities } from '../../lib/html-entities.js';
import {
  CopyableTextRow,
  StaffContactValue,
  genderLabel,
  initials,
  partyLabel,
  partyShortCode,
  stateDistrict,
  yearFromDate,
} from './DirectoryPage.js';
import type { DirectoryContactNote, DirectoryEntry } from './directoryData.js';

/**
 * The rich member detail view: seven tabs (Contact, Staff, Bio, Committees,
 * Leadership, Links, News) plus the Notes/Representation/FEC side panels.
 * Extracted out of `DirectoryPage` so the same depth is available wherever a
 * member can be selected — canonical's own `/directory` list and Directory
 * vNext's Congressional Staff screen both render this exact component, so the
 * two surfaces cannot drift apart on what a "member profile" shows.
 *
 * Deliberately Ant Design throughout, matching the source it was extracted
 * from — the point is identical data and identical depth, not a vNext-styled
 * reskin. `theme.css` (imported once at the app root in `main.tsx`) is shared
 * by every surface regardless of which shell renders around it, so no CSS
 * import is needed here for the `directory-*` classes below to work.
 */
export function DirectoryMemberProfileModal({
  entry,
  open,
  onClose,
}: {
  entry: DirectoryEntry | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();

  async function copyContact(value: string, label: string) {
    if (!value) {
      message.warning(`No ${label.toLowerCase()} on this profile.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      message.success(`Copied ${label.toLowerCase()}.`);
    } catch {
      message.error('Clipboard copy failed in this browser context.');
    }
  }

  return (
    <Modal
      className="directory-profile-modal"
      width={1120}
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      destroyOnClose
    >
      {entry ? (
        <>
          <div style={{ marginBottom: 8 }}>
            <Link to={`/directory/members/${encodeURIComponent(entry.id)}`}>
              Open full profile ↗
            </Link>
          </div>
          <section className="directory-profile-hero">
            <Avatar
              src={entry.photoUrl || undefined}
              size={86}
              shape="square"
              className="directory-profile-photo"
            >
              {initials(entry.memberName)}
            </Avatar>
            <div className="directory-profile-main">
              <Space size={8} wrap className="directory-profile-pills">
                <Tag className="directory-profile-member-tag">{entry.chamber || 'Member'}</Tag>
                {partyShortCode(entry.party) ? (
                  <span
                    className={`party-pill ${partyShortCode(entry.party)!.toLowerCase()}`}
                    title={partyLabel(entry.party)}
                  >
                    {partyShortCode(entry.party)}
                  </span>
                ) : null}
                {stateDistrict(entry) ? (
                  <span className="state-pill num">{stateDistrict(entry)}</span>
                ) : null}
              </Space>
              <Typography.Title level={2}>{entry.fullName}</Typography.Title>
              <Typography.Text>{entry.title}</Typography.Text>
              <Typography.Text type="secondary">
                Serving in {entry.chamber} since {yearFromDate(entry.servingSince)}
              </Typography.Text>
            </div>
            <Space className="directory-profile-actions" wrap>
              <Button aria-label="Copy email" onClick={() => copyContact(entry.email, 'Email')}>
                <MailOutlined />
              </Button>
              <Button aria-label="Copy phone" onClick={() => copyContact(entry.phone, 'Phone')}>
                <PhoneOutlined />
              </Button>
              {entry.contactFormUrl ? (
                <Button href={entry.contactFormUrl} target="_blank" rel="noreferrer">
                  Contact Form
                </Button>
              ) : null}
            </Space>
          </section>

          <Tabs
            className="directory-profile-tabs"
            defaultActiveKey="contact"
            items={[
              {
                key: 'contact',
                label: 'Contact',
                children: (
                  <Row gutter={[24, 24]}>
                    <Col xs={24} lg={15}>
                      <Typography.Title level={4}>Contact</Typography.Title>
                      <div className="directory-contact-panel">
                        <div>
                          <Typography.Text strong>Main Office</Typography.Text>
                          <Typography.Paragraph>
                            {entry.officeLocation || 'No public office address listed'}
                          </Typography.Paragraph>
                          <div className="directory-profile-contact-lines">
                            <CopyableTextRow
                              label="Phone"
                              value={entry.phone}
                              emptyText="N/A"
                              onCopy={copyContact}
                            />
                            <Typography.Text>Fax: {entry.fax || 'N/A'}</Typography.Text>
                            <CopyableTextRow
                              label="Email"
                              value={entry.email}
                              emptyText="No public email listed"
                              onCopy={copyContact}
                            />
                          </div>
                        </div>
                        <div>
                          <Typography.Text strong>Official Links</Typography.Text>
                          <Space direction="vertical" size={4} style={{ display: 'flex', marginTop: 8 }}>
                            {entry.officialLinks.slice(0, 8).map((link) => (
                              <a key={`${link.type}-${link.url}`} href={link.url} target="_blank" rel="noreferrer">
                                {link.label}
                              </a>
                            ))}
                          </Space>
                        </div>
                      </div>

                      <Typography.Title level={4} style={{ marginTop: 28 }}>
                        Office Locations
                      </Typography.Title>
                      <div className="directory-address-list">
                        {entry.addresses.map((address) => (
                          <div key={address.id} className="directory-address-row">
                            <Typography.Text strong>{address.title || 'Office'}</Typography.Text>
                            <Typography.Text>
                              {[address.address1, address.address2, address.city, address.state, address.zip]
                                .filter(Boolean)
                                .join(', ')}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              {address.phone || 'No phone'} {address.fax ? `| Fax ${address.fax}` : ''}
                            </Typography.Text>
                          </div>
                        ))}
                      </div>
                    </Col>
                    <Col xs={24} lg={9}>
                      <Card className="directory-side-card" title="Snapshot">
                        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
                          <Typography.Text>
                            Party: {entry.partyName} ({entry.party})
                          </Typography.Text>
                          <Typography.Text>Gender: {genderLabel(entry.gender)}</Typography.Text>
                          <Typography.Text>Region: {entry.region}</Typography.Text>
                          {entry.senateClass ? (
                            <Typography.Text>Senate class: {romanNumeral(entry.senateClass)}</Typography.Text>
                          ) : null}
                          {entry.outgoingStatus ? (
                            <Typography.Text type="warning">{entry.outgoingStatus}</Typography.Text>
                          ) : null}
                          <Typography.Text>Last source update: {entry.lastTouchpoint}</Typography.Text>
                        </Space>
                      </Card>
                      {entry.topIssues.length > 0 ? (
                        <Card className="directory-side-card" title="Top issues by staff coverage">
                          <Space size={[8, 8]} wrap>
                            {entry.topIssues.map((issue) => (
                              <Tag key={issue.issue} color="blue">
                                {issue.issue} · {issue.stafferCount}
                              </Tag>
                            ))}
                          </Space>
                          <Typography.Paragraph
                            type="secondary"
                            style={{ fontSize: 11, margin: '10px 0 0', lineHeight: 1.4 }}
                          >
                            Number of this office's staffers tagged to each issue — a proxy for where the
                            office invests, not a complete policy position.
                          </Typography.Paragraph>
                        </Card>
                      ) : null}
                      <DirectoryNotesPanel entry={entry} />
                      <DirectoryRepresentationPanel entry={entry} />
                      <DirectoryFecPanel entry={entry} />
                    </Col>
                  </Row>
                ),
              },
              {
                key: 'staff',
                label: 'Staff',
                children: (
                  <div>
                    <Typography.Title level={4}>{entry.fullName}'s Staff</Typography.Title>
                    <div className="directory-staff-list">
                      {entry.staff.length > 0 ? (
                        <>
                          <div className="directory-staff-header" aria-hidden="true">
                            <span>Staffer</span>
                            <span>Roles &amp; Issue Areas</span>
                            <span>Phone</span>
                            <span>Email</span>
                          </div>
                          {entry.staff.map((staffer) => (
                            <div key={staffer.id} className="directory-staff-row">
                              <div className="directory-staff-person">
                                <Typography.Text strong>
                                  <Link to={`/directory/staff/${encodeURIComponent(staffer.id)}`}>
                                    {staffer.fullName}
                                  </Link>
                                </Typography.Text>
                                <Typography.Text type="secondary">{staffer.title}</Typography.Text>
                              </div>
                              <Space className="directory-staff-tags" size={[6, 6]} wrap>
                                {staffer.roles.slice(0, 2).map((role) => (
                                  <Tag key={`${staffer.id}-${role}`}>{role}</Tag>
                                ))}
                                {staffer.issueAreas.slice(0, 3).map((issue) => (
                                  <Tag key={`${staffer.id}-${issue}`} color="blue">
                                    {issue}
                                  </Tag>
                                ))}
                              </Space>
                              <StaffContactValue
                                icon={<PhoneOutlined />}
                                label="Phone"
                                value={staffer.phone || entry.phone}
                                emptyText="None listed"
                                onCopy={copyContact}
                              />
                              <StaffContactValue
                                icon={<MailOutlined />}
                                label="Email"
                                value={staffer.email}
                                emptyText="None listed"
                                onCopy={copyContact}
                              />
                            </div>
                          ))}
                        </>
                      ) : (
                        <Empty description="No staff records in source snapshot" />
                      )}
                    </div>
                  </div>
                ),
              },
              {
                key: 'bio',
                label: 'Bio',
                children: (
                  <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                    {entry.bio.narrative ? (
                      <Card size="small" className="directory-bio-card">
                        <Typography.Text type="secondary">Biography</Typography.Text>
                        <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-line' }}>
                          {entry.bio.narrative}
                        </Typography.Paragraph>
                      </Card>
                    ) : null}
                    <Row gutter={[24, 16]}>
                      {[
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
                      ]
                        .filter(([, value]) => value)
                        .map(([label, value]) => (
                          <Col xs={24} sm={12} lg={8} key={label}>
                            <Card size="small" className="directory-bio-card">
                              <Typography.Text type="secondary">{label}</Typography.Text>
                              <Typography.Paragraph>{value || 'N/A'}</Typography.Paragraph>
                            </Card>
                          </Col>
                        ))}
                    </Row>
                  </Space>
                ),
              },
              {
                key: 'committees',
                label: 'Committees',
                children: (
                  <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                    {entry.committeeLeadership.length > 0 ? (
                      <div>
                        <Typography.Text strong>Leadership roles</Typography.Text>
                        <Space size={[8, 8]} wrap style={{ display: 'flex', marginTop: 8 }}>
                          {entry.committeeLeadership.map((role) => (
                            <Tag key={role} color="gold" className="directory-large-tag">
                              {role}
                            </Tag>
                          ))}
                        </Space>
                      </div>
                    ) : null}
                    <div>
                      {entry.committeeLeadership.length > 0 ? (
                        <Typography.Text strong>All committees</Typography.Text>
                      ) : null}
                      <Space size={[8, 8]} wrap style={{ display: 'flex', marginTop: 8 }}>
                        {entry.committees.length > 0 ? (
                          entry.committees.map((committee) => (
                            <Tag key={committee} className="directory-large-tag">
                              {committee}
                            </Tag>
                          ))
                        ) : (
                          <Empty description="No committee data in source snapshot" />
                        )}
                      </Space>
                    </div>
                  </Space>
                ),
              },
              {
                key: 'leadership',
                label: 'Leadership',
                children: (
                  <Space direction="vertical" size={12} style={{ display: 'flex' }}>
                    {entry.leadershipPositions.length > 0 ? (
                      entry.leadershipPositions.map((position) => (
                        <Card key={position} size="small" className="directory-leadership-card">
                          <Typography.Text strong>{position}</Typography.Text>
                        </Card>
                      ))
                    ) : (
                      <Empty description="No current leadership roles in source snapshot" />
                    )}
                  </Space>
                ),
              },
              {
                key: 'links',
                label: 'Links',
                children: (
                  <div className="directory-link-grid">
                    {entry.officialLinks.map((link) => (
                      <a key={`${link.type}-${link.url}`} href={link.url} target="_blank" rel="noreferrer">
                        <LinkOutlined /> {link.label}
                      </a>
                    ))}
                  </div>
                ),
              },
              {
                key: 'news',
                label: 'News',
                children: <DirectoryNewsPanel entry={entry} />,
              },
            ]}
          />
        </>
      ) : null}
    </Modal>
  );
}

function romanNumeral(value: number | null): string {
  return value === 1 ? 'I' : value === 2 ? 'II' : value === 3 ? 'III' : '';
}

function formatNoteDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(date));
}

function noteAuthor(note: DirectoryContactNote): string {
  const fullName = [note.createdBy?.firstName, note.createdBy?.lastName].filter(Boolean).join(' ');
  return fullName || note.createdBy?.email || 'Former user';
}

function DirectoryNotesPanel({ entry }: { entry: DirectoryEntry }) {
  const { message } = App.useApp();
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
      message.success('Note added.');
    },
    onError: (error) => {
      message.error((error as Error).message || 'Could not add note.');
    },
  });

  const trimmedBody = body.trim();

  return (
    <Card className="directory-side-card directory-notes-card" title="Notes">
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        <Input.TextArea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add a tenant-visible note"
          maxLength={4000}
          showCount
          autoSize={{ minRows: 3, maxRows: 7 }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={createNote.isPending}
          disabled={!trimmedBody}
          onClick={() => createNote.mutate()}
        >
          Add note
        </Button>

        {notes.isLoading ? <Spin size="small" /> : null}

        {!notes.isLoading && (notes.data?.length ?? 0) === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No notes yet" />
        ) : null}

        <div className="directory-note-list">
          {(notes.data ?? []).map((note) => (
            <div key={note.id} className="directory-note-preview">
              <Typography.Paragraph>{note.body}</Typography.Paragraph>
              <Typography.Text type="secondary">
                {formatNoteDate(note.createdAt)} by {noteAuthor(note)}
              </Typography.Text>
            </div>
          ))}
        </div>
      </Space>
    </Card>
  );
}

interface MemberNewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
}

interface MemberNewsPayload {
  contactId: string;
  memberName: string;
  newsPressUrl: string | null;
  rssFeedUrl: string | null;
  rssSource: string | null;
  items: MemberNewsItem[];
  lastSyncedAt: string | null;
  feedError: 'no_feed' | null;
}

function formatNewsDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * News tab: the member's recent press releases, pre-ingested into member_press_item
 * every ~3 days by the sync-member-press job (no live fetch on profile view). Each
 * item shows title + date + the feed's summary and links out to the full release.
 */
function DirectoryNewsPanel({ entry }: { entry: DirectoryEntry }) {
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
    <Space size={8} wrap style={{ marginBottom: 12 }}>
      {data?.newsPressUrl ? (
        <Button size="small" icon={<LinkOutlined />} href={data.newsPressUrl} target="_blank" rel="noreferrer">
          Press page
        </Button>
      ) : null}
      {data?.rssFeedUrl ? (
        <Button size="small" icon={<LinkOutlined />} href={data.rssFeedUrl} target="_blank" rel="noreferrer">
          RSS feed
        </Button>
      ) : null}
    </Space>
  );

  if (query.isLoading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <>
        {links}
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            data?.feedError === 'no_feed' && !data?.newsPressUrl
              ? 'No news feed or press page on file for this member.'
              : 'No recent press releases.'
          }
        >
          {data?.newsPressUrl ? (
            <Button type="primary" href={data.newsPressUrl} target="_blank" rel="noreferrer">
              Open press page
            </Button>
          ) : null}
        </Empty>
      </>
    );
  }

  return (
    <>
      {links}
      <div className="directory-news-list">
        {items.map((item) => (
          <div key={item.id} className="directory-news-item">
            <a
              className="directory-news-item-title"
              href={item.link || data?.newsPressUrl || undefined}
              target="_blank"
              rel="noreferrer"
            >
              {decodeHtmlEntities(item.title)}
            </a>
            {item.publishedAt ? (
              <div className="directory-news-item-date">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatNewsDate(item.publishedAt)}
                </Typography.Text>
              </div>
            ) : null}
            {item.summary ? (
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0' }} ellipsis={{ rows: 3 }}>
                {decodeHtmlEntities(item.summary)}
              </Typography.Paragraph>
            ) : null}
          </div>
        ))}
      </div>
      {data?.lastSyncedAt ? (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 12 }}>
          Updated {formatNewsDate(data.lastSyncedAt)}
        </Typography.Text>
      ) : null}
    </>
  );
}

interface MemberRepresentationSummary {
  clients: Array<{
    clientId: string;
    clientName: string;
    facilities: Array<{ id: string; name: string }>;
  }>;
}

/**
 * District Impact Engine (Phase 1 M1.4) — "Represents client facilities":
 * every client (tenant-wide) with a facility in this member's district.
 * Deterministic (bioguideId + district join) — NOT name-matched like the FEC
 * panel below, so no approximate-match disclaimer is needed.
 */
function DirectoryRepresentationPanel({ entry }: { entry: DirectoryEntry }) {
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
    <Card className="directory-side-card" title="Represents client facilities">
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        {query.isLoading ? (
          <Spin size="small" />
        ) : (
          clients.map((c) => (
            <div key={c.clientId} className="directory-note-preview">
              <Typography.Text strong>{c.clientName}</Typography.Text>
              <div>
                <Space size={[6, 6]} wrap>
                  {c.facilities.map((f) => (
                    <Tag key={f.id}>{f.name}</Tag>
                  ))}
                </Space>
              </div>
            </div>
          ))
        )}
      </Space>
    </Card>
  );
}

interface MemberFecSummary {
  contactId: string;
  memberName: string | null;
  matchQuality: 'name_approximate';
  clients: Array<{
    clientId: string;
    clientName: string;
    mappedEmployer: string;
    totalAmount: number;
    contributionCount: number;
    latestContributionDate: string | null;
  }>;
  summary: { totalAmount: number; contributionCount: number; clientCount: number };
  disclaimer: string;
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Member-scoped FEC relationship: contributions to this member from the tenant's
 * mapped clients' employers. APPROXIMATE (name-matched) — clearly labeled — and
 * wrapped in the API-provided compliance disclaimer. Read-only context only.
 */
function DirectoryFecPanel({ entry }: { entry: DirectoryEntry }) {
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
    <Card
      className="directory-side-card"
      title={
        <Space size={8}>
          <span>Client FEC relationship</span>
          <Tag color="default" style={{ fontSize: 10 }}>
            approximate · name-matched
          </Tag>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        {query.isLoading ? (
          <Spin size="small" />
        ) : hasData ? (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatUsd(data!.summary.totalAmount)} across {data!.summary.contributionCount} contribution
              {data!.summary.contributionCount !== 1 ? 's' : ''} from {data!.summary.clientCount} mapped client
              {data!.summary.clientCount !== 1 ? 's' : ''}.
            </Typography.Text>
            <div className="directory-note-list">
              {data!.clients.map((c) => (
                <div key={c.clientId} className="directory-note-preview">
                  <Space style={{ justifyContent: 'space-between', display: 'flex', width: '100%' }}>
                    <Typography.Text strong>{c.clientName}</Typography.Text>
                    <Tag color="green">{formatUsd(c.totalAmount)}</Tag>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    via employer {c.mappedEmployer} · {c.contributionCount} contribution
                    {c.contributionCount !== 1 ? 's' : ''}
                  </Typography.Text>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No contributions from your mapped clients matched this member."
          />
        )}

        <Typography.Paragraph type="secondary" style={{ fontSize: 10, margin: 0, lineHeight: 1.4 }}>
          {data?.disclaimer ??
            'Source: public FEC filings, for informational purposes only — not legal or campaign-finance advice. ' +
              'Matches are approximate (by candidate name) and reflect individual filers, legally distinct from ' +
              'corporate/PAC giving. Not a recommendation to make any contribution. Verify at FEC.gov.'}
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}
