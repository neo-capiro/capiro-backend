import { useState } from 'react';
import { Drawer, Pagination, Spin } from 'antd';
import { BankOutlined, CloseOutlined, LinkOutlined, MailOutlined } from '@ant-design/icons';
import { stateBillStatusLabel } from '@capiro/shared';
import { StateBillDetailBody } from '../explorer/state-bill-detail.js';

// ── Types (self-contained — mirrors the api/explorer.service.ts response shapes) ──
export interface StateLegislatorBase {
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

// List-row shape (/api/explorer/state-legislators). The three counts drive the
// card stat strip. billCount/enactedCount are `null` — NOT 0 — for a legislator
// never crosswalked to LegiScan bill data (legiscanPeopleId is null): "unknown",
// not "sponsors nothing". The card renders "—" for that, never a fabricated 0.
export interface StateLegislatorRow extends StateLegislatorBase {
  committeeCount: number;
  billCount: number | null;
  enactedCount: number | null;
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

export interface StateLegislatorDetail extends StateLegislatorBase {
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

// ── Shared helpers ────────────────────────────────────────────────────────
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

// Party → newsroom tone class. Democrat → info (blue), Republican → critical
// (red), everything else (Independent, Nonpartisan, …) → notable (amber), so a
// non-D/R legislator is never mis-coloured as red.
type Tone = 'info' | 'critical' | 'notable';
function partyTone(party: string | null): Tone {
  const p = (party ?? '').trim().toLowerCase();
  if (p.startsWith('d')) return 'info';
  if (p.startsWith('r')) return 'critical';
  return 'notable';
}

function partyCode(party: string | null): string | null {
  const p = (party ?? '').trim();
  if (!p) return null;
  return (p[0] ?? '').toUpperCase() || null;
}

function partyLabelText(party: string | null): string {
  const p = (party ?? '').trim();
  if (!p) return '';
  if (p.length === 1) {
    const u = p.toUpperCase();
    return u === 'D' ? 'Democrat' : u === 'R' ? 'Republican' : u === 'I' ? 'Independent' : u;
  }
  return p;
}

// Bill status → the same four-tone palette the mockup uses. Label text still
// comes from @capiro/shared's stateBillStatusLabel, the canonical mapping the
// nested StateBillDetailBody drawer uses, so a bill reads identically in both.
function statusTone(status: string | null): 'success' | 'info' | 'critical' | 'notable' | 'muted' {
  if (!status) return 'muted';
  if (['enacted', 'veto_overridden'].includes(status)) return 'success';
  if (['vetoed', 'failed', 'dead_by_deadline'].includes(status)) return 'critical';
  if (['passed_chamber', 'resolving', 'to_governor'].includes(status)) return 'info';
  return 'notable'; // introduced / committee / reported / floor
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtCount(n: number | null): string {
  return n == null ? '—' : n.toLocaleString();
}

// ── Avatar (party-gradient circle w/ initials, or photo when present) ───────
function LegAvatar({
  name,
  image,
  tone,
  size,
}: {
  name: string;
  image: string | null;
  tone: Tone;
  size: number;
}) {
  return (
    <div
      className={`leg-avatar ${tone}`}
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {image ? <img src={image} alt="" /> : <span>{initials(name)}</span>}
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  return (
    <span className={`leg-status ${statusTone(status)}`}>
      <span className="d" />
      {stateBillStatusLabel(status)}
    </span>
  );
}

// ── Card ────────────────────────────────────────────────────────────────
function LegCard({ leg, onSelect }: { leg: StateLegislatorRow; onSelect: (id: string) => void }) {
  const tone = partyTone(leg.party);
  const code = partyCode(leg.party);
  const partyText = partyLabelText(leg.party);
  return (
    <button className={`leg-card ${tone}`} type="button" onClick={() => onSelect(leg.id)}>
      <span className="leg-accent" />
      <div className="leg-card-head">
        <LegAvatar name={leg.name} image={leg.image} tone={tone} size={46} />
        <div className="leg-id">
          <div className="leg-name">{leg.name}</div>
          <div className="leg-chamber">
            <BankOutlined />
            {chamberLabel(leg.chamber)}
            {leg.district ? ` · District ${leg.district}` : ''}
          </div>
        </div>
        {code ? <span className={`leg-party ${tone}`}>{code}</span> : null}
      </div>

      <div className="leg-stats">
        <div className="leg-stat">
          <div className="v num">{fmtCount(leg.billCount)}</div>
          <div className="l">Bills</div>
        </div>
        <div className="leg-stat">
          <div className="v num" style={leg.enactedCount ? { color: 'var(--success)' } : undefined}>
            {fmtCount(leg.enactedCount)}
          </div>
          <div className="l">Enacted</div>
        </div>
        <div className="leg-stat">
          <div className="v num">{leg.committeeCount.toLocaleString()}</div>
          <div className="l">Committees</div>
        </div>
      </div>

      <div className="leg-foot">
        <span className="leg-state num">{leg.state}</span>
        {partyText ? <span className="leg-partylabel">{partyText}</span> : null}
        <span className="leg-spacer" />
        {leg.email ? (
          <span className="leg-email">
            <MailOutlined />
            Email on file
          </span>
        ) : null}
      </div>
    </button>
  );
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
      <div className="leg-empty">
        We couldn't load state legislators.{' '}
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (legislators.length === 0) {
    return <div className="leg-empty">No state legislators match these filters.</div>;
  }

  return (
    <>
      <div className="leg-grid">
        {legislators.map((legislator) => (
          <LegCard key={legislator.id} leg={legislator} onSelect={onSelect} />
        ))}
      </div>
      {total > pageSize ? (
        <div className="directory-pagination">
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            onChange={onPage}
            showSizeChanger={false}
          />
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

export function StateLegislatorDrawer({
  open,
  legislator,
  loading = false,
  onClose,
}: StateLegislatorDrawerProps) {
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyEmail(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard may be unavailable in this browser context — non-fatal.
    }
  }

  const tone: Tone = legislator ? partyTone(legislator.party) : 'info';
  const ready = !loading && legislator;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        width={468}
        closable={false}
        destroyOnClose
        rootClassName="leg-drawer-portal"
        styles={{ body: { padding: 0, overflow: 'hidden' } }}
      >
        <button
          className={`leg-close${ready ? ' on-dark' : ''}`}
          type="button"
          aria-label="Close"
          onClick={onClose}
        >
          <CloseOutlined />
        </button>

        {!ready ? (
          <div className="leg-drawer-loading">
            <Spin />
          </div>
        ) : (
          <div className={`leg-drawer-content ${tone}`}>
            <div className="leg-drawer-hero">
              <LegAvatar name={legislator.name} image={legislator.image} tone={tone} size={72} />
              <div className="leg-hero-id">
                <div className="leg-hero-name">{legislator.name}</div>
                <div className="leg-hero-chamber">
                  <BankOutlined />
                  {chamberLabel(legislator.chamber)}
                  {legislator.district ? ` · District ${legislator.district}` : ''}
                </div>
                <div className="leg-hero-tags">
                  <span className="leg-hero-state num">{legislator.state}</span>
                  {partyLabelText(legislator.party) ? (
                    <span className={`leg-hero-party ${tone}`}>
                      {partyLabelText(legislator.party)}
                    </span>
                  ) : null}
                  {!legislator.active ? <span className="leg-hero-inactive">Inactive</span> : null}
                </div>
                {legislator.url ? (
                  <a
                    className="leg-openstates"
                    href={legislator.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <LinkOutlined />
                    View OpenStates profile
                  </a>
                ) : null}
              </div>
            </div>

            <div className="leg-drawer-body">
              {/* Contact */}
              <section className="leg-section">
                <div className="leg-section-h">Contact</div>
                {legislator.email ? (
                  <div className="leg-contact">
                    <span className="num">{legislator.email}</span>
                    <button
                      className={`leg-copy${copied ? ' done' : ''}`}
                      type="button"
                      onClick={() => copyEmail(legislator.email as string)}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ) : (
                  <div className="leg-muted">No email on file.</div>
                )}
              </section>

              {/* Committees */}
              <section className="leg-section">
                <div className="leg-section-h">
                  Committees <span className="cnt">{legislator.committees.length}</span>
                </div>
                {legislator.committees.length ? (
                  <div className="leg-committees">
                    {legislator.committees.map((c) => {
                      const isChair = (c.role ?? '').toLowerCase().includes('chair');
                      return (
                        <span key={c.id} className={`leg-committee${isChair ? ' chair' : ''}`}>
                          {c.name}
                          {c.role ? <span className="role">{c.role}</span> : null}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <div className="leg-muted">No committee assignments on record yet.</div>
                )}
              </section>

              {/* Sponsored bills */}
              <section className="leg-section">
                <div className="leg-section-h">
                  Sponsored bills
                  {legislator.sponsoredBills ? (
                    <span className="cnt">{legislator.sponsoredBillsTotal}</span>
                  ) : null}
                </div>
                {legislator.sponsoredBills === null ? (
                  <div className="leg-muted">
                    Not yet linked to bill-sponsorship data for this legislator's state — bill
                    ingestion for that state hasn't run yet.
                  </div>
                ) : legislator.sponsoredBills.length === 0 ? (
                  <div className="leg-muted">No sponsored bills found on record.</div>
                ) : (
                  <div className="leg-bills">
                    {legislator.sponsoredBills.map((b) => (
                      <button
                        key={b.billId}
                        className="leg-bill"
                        type="button"
                        onClick={() => setSelectedBillId(b.billId)}
                      >
                        <div className="leg-bill-top">
                          <span className="leg-bill-num num">{b.identifier}</span>
                          <StatusPill status={b.status} />
                          {b.sponsorType === 'primary' ? (
                            <span className="leg-bill-primary">Primary sponsor</span>
                          ) : null}
                        </div>
                        <div className="leg-bill-title">{b.title}</div>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {/* Provenance */}
              <div className="leg-drawer-prov">
                Last synced {formatDate(legislator.syncedAt)} ·{' '}
                {legislator.legiscanPeopleId != null
                  ? 'Linked to LegiScan'
                  : 'Not yet linked to LegiScan'}
              </div>
            </div>
          </div>
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
