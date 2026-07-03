import { Card, Empty, List, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { FolderOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { ProgramElementBill } from './types.js';

const { Text } = Typography;

export interface BillsTouchingPePanelProps {
  bills: ProgramElementBill[];
  loading?: boolean;
}

function truncate(value: string, max = 90): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

// Congress.gov bill-type codes → conventional citation form (e.g. HR → "H.R.").
const BILL_TYPE_LABELS: Record<string, string> = {
  HR: 'H.R.',
  S: 'S.',
  HJRES: 'H.J.Res.',
  SJRES: 'S.J.Res.',
  HCONRES: 'H.Con.Res.',
  SCONRES: 'S.Con.Res.',
  HRES: 'H.Res.',
  SRES: 'S.Res.',
};

function billLabel(bill: ProgramElementBill): string {
  const type = BILL_TYPE_LABELS[bill.billType?.toUpperCase()] ?? bill.billType ?? '';
  return `${type} ${bill.billNumber}`.trim() || bill.id;
}

// Chamber eyebrow derived from bill type (H* = House, S* = Senate).
function chamberLabel(bill: ProgramElementBill): string {
  const t = (bill.billType ?? '').toUpperCase();
  if (t.startsWith('H')) return 'HOUSE';
  if (t.startsWith('S')) return 'SENATE';
  return 'CONGRESS';
}

// Status pill from the latest-action text. Honest: only label states we can
// confidently infer from the action text; otherwise show nothing.
function statusPill(bill: ProgramElementBill): { label: string; cls: string } | null {
  const text = (bill.latestActionText ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('became public law') || text.includes('signed by president') || text.includes('became law')) {
    return { label: 'BECAME LAW', cls: 'success' };
  }
  if (text.includes('reported')) return { label: 'REPORTED', cls: 'info' };
  if (text.includes('passed')) return { label: 'PASSED', cls: 'info' };
  if (text.includes('referred') || text.includes('introduced')) return { label: 'INTRODUCED', cls: 'muted' };
  return null;
}

function formatActionDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function probabilityColor(probability: number | null | undefined): string {
  const p = typeof probability === 'number' ? probability : 0;
  if (p > 0.7) return 'green';
  if (p >= 0.4) return 'gold';
  return 'red';
}

function probabilityLabel(probability: number | null | undefined): string {
  if (typeof probability !== 'number') return 'N/A';
  return `${Math.round(probability * 100)}%`;
}

// A bill that references this many distinct PEs or more is a blanket authorizer
// (the annual NDAA references ~700) rather than a PE-specific bill. We still show
// it — it's real legislation — but tag it and let the API sink it to the bottom
// so the genuinely PE-specific bills lead.
const BLANKET_PE_THRESHOLD = 50;

function isBlanketAuthorizer(bill: ProgramElementBill): boolean {
  return (bill.peCodeCount ?? 0) >= BLANKET_PE_THRESHOLD;
}

export function BillsTouchingPePanel({ bills, loading = false }: BillsTouchingPePanelProps) {
  const navigate = useNavigate();

  if (loading) {
    return (
      <Card title="Bills touching this PE">
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
    );
  }

  if (bills.length === 0) {
    return (
      <Card title="Bills touching this PE">
        <Empty description="No linked bills yet" />
      </Card>
    );
  }

  return (
    <Card
      className="pe-bills-card"
      title="Bills touching this PE"
      extra={<Text type="secondary">{bills.length} linked</Text>}
    >
      <div className="pe-scroll-5">
        <List
          className="pe-bills-list"
          dataSource={bills}
          renderItem={(bill) => {
            // Honest action chip: show passage probability only when the model
            // actually produced one; otherwise surface the policy area, which is
            // real metadata, instead of a misleading "N/A" score.
            const hasProbability = typeof bill.passageProbability === 'number';
            const actionDate = formatActionDate(bill.latestActionDate);
            const pill = statusPill(bill);
            const blanket = isBlanketAuthorizer(bill);
            const meta = [bill.sponsor ?? 'Sponsor N/A', bill.committee ?? 'Committee N/A'];
            if (actionDate) meta.push(`Last action ${actionDate}`);

            return (
              <List.Item
                key={bill.id}
                className={`pe-bill-row${blanket ? ' pe-bill-blanket' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/intelligence/bills/${encodeURIComponent(bill.id)}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate(`/intelligence/bills/${encodeURIComponent(bill.id)}`);
                  }
                }}
                style={{ cursor: 'pointer' }}
              >
                <div className="pe-bill-ident">
                  <span className="pe-bill-num">{billLabel(bill)}</span>
                  <span className="pe-bill-chamber">{chamberLabel(bill)}</span>
                </div>
                <div className="pe-bill-body">
                  <div className="pe-bill-title">{truncate(bill.title)}</div>
                  <div className="pe-bill-meta">{meta.join(' • ')}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {bill.policyArea ? (
                      <span className="pe-bill-policy">
                        <FolderOutlined /> {bill.policyArea}
                      </span>
                    ) : null}
                    {blanket ? (
                      <Tooltip
                        title={`This bill references ${bill.peCodeCount?.toLocaleString()} program elements — it's a blanket authorizer (e.g. the annual NDAA), not a PE-specific bill.`}
                      >
                        <span className="pe-bill-blanket-tag">
                          Blanket authorizer · {bill.peCodeCount?.toLocaleString()} PEs
                        </span>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                <div className="pe-bill-status">
                  {pill ? <span className={`pill ${pill.cls}`}>{pill.label}</span> : null}
                  {hasProbability ? (
                    <Tag color={probabilityColor(bill.passageProbability)}>
                      {probabilityLabel(bill.passageProbability)}
                    </Tag>
                  ) : !pill ? (
                    <Text type="secondary">{bill.congress}th</Text>
                  ) : null}
                </div>
              </List.Item>
            );
          }}
        />
      </div>
    </Card>
  );
}

export function billProbabilityColor(probability: number | null | undefined): string {
  return probabilityColor(probability);
}
