import { useState } from 'react';
import {
  Avatar,
  Button,
  Card,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Flex,
  List,
  Pagination,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { BankOutlined, LinkOutlined, MailOutlined } from '@ant-design/icons';
import { stateBillStatusLabel } from '@capiro/shared';
import { StateBillDetailBody } from '../explorer/state-bill-detail.js';

const { Text, Link } = Typography;

// ── Types (self-contained — mirrors the api/explorer.service.ts response shapes) ──
export interface StateLegislatorRow {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  district: string | null;
  party: string | null;
  email: string | null;
  image: string | null;
  url: string | null;
}

export interface StateLegislatorFacets {
  states: string[];
  chambers: string[];
  parties: string[];
}

export interface StateLegislatorCommittee {
  id: string;
  name: string;
  chamber: string | null;
  role: string | null;
}

export interface StateLegislatorSponsoredBill {
  billId: string;
  identifier: string;
  title: string;
  chamber: string | null;
  status: string | null;
  statusAt: string | null;
  sponsorType: string;
}

export interface StateLegislatorDetail extends StateLegislatorRow {
  active: boolean;
  legiscanPeopleId: number | null;
  syncedAt: string;
  committees: StateLegislatorCommittee[];
  // null = this legislator has never been crosswalked to LegiScan bill data
  // (distinct from an empty array, which means "linked, but sponsors nothing
  // currently on record") — never collapse the two, it would fabricate a
  // "sponsors nothing" claim for a state/legislator we simply haven't ingested.
  sponsoredBills: StateLegislatorSponsoredBill[] | null;
  sponsoredBillsTotal: number;
}

// ── Shared helpers (self-contained; mirror DowDirectoryResults conventions) ──
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0];
  if (!first) return '?';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

function chamberLabel(chamber: string | null): string {
  if (chamber === 'upper') return 'Senate';
  if (chamber === 'lower') return 'House';
  return chamber ?? '—';
}

function partyPillClass(party: string | null): string {
  const p = (party ?? '').trim().toLowerCase();
  if (p.startsWith('d')) return 'party-pill d';
  if (p.startsWith('r')) return 'party-pill r';
  return 'party-pill i';
}

// Label text comes from @capiro/shared's stateBillStatusLabel — the SAME
// canonical mapping StateBillDetailBody (rendered a click away, in the nested
// bill drawer below) uses, so a bill's status reads identically in both.
function statusColor(status: string | null): string {
  if (!status) return 'default';
  if (['enacted'].includes(status)) return 'green';
  if (['vetoed', 'failed', 'dead_by_deadline'].includes(status)) return 'red';
  if (['passed_chamber', 'to_governor', 'veto_overridden'].includes(status)) return 'blue';
  return 'default';
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── List card grid ───────────────────────────────────────────────────────
export interface StateLegislatorResultsProps {
  legislators: StateLegislatorRow[];
  loading?: boolean;
  total: number;
  page: number;
  pageSize: number;
  isError?: boolean;
  onPage: (page: number) => void;
  onSelect: (id: string) => void;
  onRetry?: () => void;
}

export function StateLegislatorResults({
  legislators,
  loading = false,
  total,
  page,
  pageSize,
  isError = false,
  onPage,
  onSelect,
  onRetry,
}: StateLegislatorResultsProps) {
  if (loading) {
    return (
      <div className="directory-grid-loading" style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (isError) {
    return (
      <Empty description="We couldn't load state legislators. Please try again.">
        {onRetry ? <Link onClick={onRetry}>Retry</Link> : null}
      </Empty>
    );
  }
  if (legislators.length === 0) {
    return <Empty description="No state legislators found" />;
  }

  return (
    <>
      <div className="directory-card-grid">
        {legislators.map((legislator) => (
          <Card
            key={legislator.id}
            hoverable
            size="small"
            onClick={() => onSelect(legislator.id)}
            style={{ cursor: 'pointer' }}
          >
            <Flex gap={12} align="flex-start">
              <Avatar size={48} src={legislator.image ?? undefined} style={{ flexShrink: 0, backgroundColor: '#1f3a5f' }}>
                {initials(legislator.name)}
              </Avatar>
              <Space direction="vertical" size={2} style={{ flex: 1, minWidth: 0 }}>
                <Flex align="center" gap={6} wrap>
                  <Text strong ellipsis style={{ maxWidth: '100%' }}>
                    {legislator.name}
                  </Text>
                  {legislator.party ? <span className={partyPillClass(legislator.party)}>{legislator.party}</span> : null}
                </Flex>
                <Text type="secondary" ellipsis>
                  {chamberLabel(legislator.chamber)}
                  {legislator.district ? ` · District ${legislator.district}` : ''}
                </Text>
                <Flex align="center" gap={6} wrap style={{ marginTop: 4 }}>
                  <span className="state-pill num">{legislator.state}</span>
                  {legislator.email ? (
                    <Tag bordered={false} icon={<MailOutlined />}>
                      Email on file
                    </Tag>
                  ) : null}
                </Flex>
              </Space>
            </Flex>
          </Card>
        ))}
      </div>
      {total > pageSize ? (
        <div className="directory-pagination">
          <Pagination current={page} pageSize={pageSize} total={total} onChange={onPage} showSizeChanger={false} />
        </div>
      ) : null}
    </>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────
export interface StateLegislatorDrawerProps {
  open: boolean;
  legislator: StateLegislatorDetail | null;
  loading?: boolean;
  onClose: () => void;
}

export function StateLegislatorDrawer({ open, legislator, loading = false, onClose }: StateLegislatorDrawerProps) {
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);

  async function copyEmail(email: string) {
    try {
      await navigator.clipboard.writeText(email);
    } catch {
      // Clipboard may be unavailable in this browser context — non-fatal.
    }
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        width={560}
        title={legislator ? legislator.name : 'State legislator'}
        destroyOnClose
      >
        {loading || !legislator ? (
          <Spin />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {/* Header: photo + identity */}
            <Flex gap={16} align="flex-start">
              <Avatar
                size={72}
                src={legislator.image ?? undefined}
                style={{ flexShrink: 0, backgroundColor: '#1f3a5f', fontSize: 24 }}
              >
                {initials(legislator.name)}
              </Avatar>
              <Space direction="vertical" size={2} style={{ flex: 1, minWidth: 0 }}>
                <Text type="secondary">
                  <BankOutlined /> {chamberLabel(legislator.chamber)}
                  {legislator.district ? ` · District ${legislator.district}` : ''}
                </Text>
                <Flex gap={6} wrap style={{ marginTop: 6 }}>
                  <span className="state-pill num">{legislator.state}</span>
                  {legislator.party ? <span className={partyPillClass(legislator.party)}>{legislator.party}</span> : null}
                  {!legislator.active ? <Tag color="orange">Inactive</Tag> : null}
                </Flex>
                {legislator.url ? (
                  <Button
                    type="link"
                    size="small"
                    icon={<LinkOutlined />}
                    href={legislator.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ paddingLeft: 0, marginTop: 4 }}
                  >
                    View OpenStates profile
                  </Button>
                ) : null}
              </Space>
            </Flex>

            {/* Contact */}
            <div>
              <Text strong>
                <MailOutlined /> Contact
              </Text>
              <div style={{ marginTop: 8 }}>
                {legislator.email ? (
                  <Flex align="center" gap={8}>
                    <a href={`mailto:${legislator.email}`}>{legislator.email}</a>
                    <Button type="text" size="small" onClick={() => copyEmail(legislator.email as string)}>
                      Copy
                    </Button>
                  </Flex>
                ) : (
                  <Text type="secondary">No email on file.</Text>
                )}
              </div>
            </div>

            {/* Committees */}
            <div>
              <Text strong>Committees ({legislator.committees.length})</Text>
              <div style={{ marginTop: 8 }}>
                {legislator.committees.length ? (
                  <Flex gap={6} wrap>
                    {legislator.committees.map((c) => (
                      <Tag key={c.id}>
                        {c.name}
                        {c.role ? ` · ${c.role}` : ''}
                      </Tag>
                    ))}
                  </Flex>
                ) : (
                  <Text type="secondary">No committee assignments on record yet.</Text>
                )}
              </div>
            </div>

            <Divider style={{ margin: '4px 0' }} />

            {/* Sponsored bills */}
            <div>
              <Text strong>
                Sponsored bills
                {legislator.sponsoredBills ? ` (${legislator.sponsoredBillsTotal})` : ''}
              </Text>
              <div style={{ marginTop: 8 }}>
                {legislator.sponsoredBills === null ? (
                  <Text type="secondary">
                    Not yet linked to bill-sponsorship data for this legislator's state — bill ingestion for that
                    state hasn't run yet.
                  </Text>
                ) : legislator.sponsoredBills.length === 0 ? (
                  <Text type="secondary">No sponsored bills found on record.</Text>
                ) : (
                  <List
                    size="small"
                    dataSource={legislator.sponsoredBills}
                    rowKey={(b) => b.billId}
                    renderItem={(b) => (
                      <List.Item onClick={() => setSelectedBillId(b.billId)} style={{ cursor: 'pointer' }}>
                        <Space direction="vertical" size={2} style={{ width: '100%' }}>
                          <Flex align="center" gap={8} wrap>
                            <Text strong>{b.identifier}</Text>
                            <Tag color={statusColor(b.status)} bordered={false}>
                              {stateBillStatusLabel(b.status)}
                            </Tag>
                            {b.sponsorType === 'primary' ? <Tag bordered={false}>Primary sponsor</Tag> : null}
                          </Flex>
                          <Text type="secondary" ellipsis>
                            {b.title}
                          </Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                )}
              </div>
            </div>

            <Divider style={{ margin: '4px 0' }} />

            {/* Provenance */}
            <div>
              <Descriptions size="small" column={1} colon={false}>
                <Descriptions.Item label="Last synced">{formatDate(legislator.syncedAt)}</Descriptions.Item>
                <Descriptions.Item label="Bill data">
                  {legislator.legiscanPeopleId != null ? 'Linked to LegiScan' : 'Not yet linked'}
                </Descriptions.Item>
              </Descriptions>
            </div>
          </Space>
        )}
      </Drawer>

      <Drawer
        open={selectedBillId !== null}
        onClose={() => setSelectedBillId(null)}
        width={720}
        title="State bill"
        destroyOnClose
        // Explicit z-index: this Drawer is a JSX sibling of the legislator
        // Drawer above, not nested inside it, so antd's parent/child Drawer
        // "push" stacking never engages between them (that only activates for
        // a genuinely nested Drawer). Without an explicit value both would
        // compute the same default base z-index and correct stacking would
        // depend on incidental portal-mount order rather than being
        // guaranteed — mirrors the explicit-tier convention used elsewhere in
        // this app for overlapping layers (meri-overlay.css, legiwatch.css).
        zIndex={1050}
      >
        {selectedBillId ? <StateBillDetailBody id={selectedBillId} /> : null}
      </Drawer>
    </>
  );
}
