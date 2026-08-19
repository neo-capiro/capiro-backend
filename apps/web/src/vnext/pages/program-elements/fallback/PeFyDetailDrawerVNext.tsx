/**
 * FY drill-down drawer — native vNext port of
 * `pages/program-element/FyDetailDrawer.tsx`. Marks table with per-mark source
 * attribution/links/dates, conference-report excerpt, linked bills, linked
 * rules. All raw-payload parsing is unchanged.
 */
import type { ProgramElementYearPoint } from '../../../../pages/program-element/types.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../../components/tables/index.js';
import { CapiroDrawer } from '../../../components/overlays/index.js';
import { PeFbEmpty } from './pe-fallback-ui.js';

type MarkField =
  | 'request'
  | 'hascMark'
  | 'sascMark'
  | 'hacDMark'
  | 'sacDMark'
  | 'ndaaConference'
  | 'conference'
  | 'enacted';

interface MarkRow {
  key: MarkField;
  label: string;
  value: string;
  sourceUrl: string | null;
  sourceLabel: string;
  dateAdded: string;
}

interface LinkedBill {
  id: string;
  title: string;
}

interface LinkedRule {
  id: string;
  title: string;
  topic: string | null;
}

export interface PeFyDetailDrawerVNextProps {
  open: boolean;
  onClose: () => void;
  peCode: string;
  selectedFy: number | null;
  timeline: ProgramElementYearPoint[];
}

const MARK_FIELDS: Array<{ key: MarkField; label: string }> = [
  { key: 'request', label: "President's Request" },
  { key: 'hascMark', label: 'HASC' },
  { key: 'sascMark', label: 'SASC' },
  { key: 'hacDMark', label: 'HAC-D' },
  { key: 'sacDMark', label: 'SAC-D' },
  // NDAA (authorization-track) conference — distinct from the appropriations
  // 'conference' rung so the authorization figure is labeled, not lost.
  { key: 'ndaaConference', label: 'NDAA Conference (auth.)' },
  { key: 'conference', label: 'Conference (approps.)' },
  { key: 'enacted', label: 'Enacted' },
];

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dollarsMm(value: number | null): string {
  if (value == null) return '-';
  return `$${value.toFixed(2)}m`;
}

function sanitizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function getRawMap(raw: unknown, key: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const candidate = raw as Record<string, unknown>;
  const nested = candidate[key];
  if (!nested || typeof nested !== 'object') return {};
  return nested as Record<string, unknown>;
}

function getRawString(rawMap: Record<string, unknown>, field: string): string | null {
  const value = rawMap[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function getRawArray(raw: unknown, key: string): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const arr = obj[key];
  return Array.isArray(arr) ? arr : [];
}

function toLinkedBills(raw: unknown): LinkedBill[] {
  return getRawArray(raw, 'linkedBills')
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const id =
        typeof obj.id === 'string' ? obj.id : typeof obj.billId === 'string' ? obj.billId : null;
      const title = typeof obj.title === 'string' ? obj.title : null;
      if (!id || !title) return null;
      return { id, title };
    })
    .filter((v): v is LinkedBill => v !== null);
}

function toLinkedRules(raw: unknown): LinkedRule[] {
  return getRawArray(raw, 'linkedRules')
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id : null;
      const title = typeof obj.title === 'string' ? obj.title : null;
      const topic = typeof obj.topic === 'string' ? obj.topic : null;
      if (!id || !title) return null;
      return { id, title, topic };
    })
    .filter((v): v is LinkedRule => v !== null);
}

function buildMarkRows(year: ProgramElementYearPoint | undefined): MarkRow[] {
  if (!year) return [];
  const sourceAttribution = getRawMap(year.raw, 'sourceAttribution');
  const sourceLinks = getRawMap(year.raw, 'sourceLinks');
  const datesAdded = getRawMap(year.raw, 'datesAdded');

  return MARK_FIELDS.map(({ key, label }) => {
    const sourceLabel = getRawString(sourceAttribution, key) ?? 'N/A';
    const sourceUrl = sanitizeUrl(getRawString(sourceLinks, key) ?? undefined);
    const dateAdded = getRawString(datesAdded, key) ?? '-';
    const rawValue = toNullableNumber(year[key]);

    return {
      key,
      label,
      value: dollarsMm(rawValue),
      sourceUrl,
      sourceLabel,
      dateAdded,
    };
  });
}

export function PeFyDetailDrawerVNext({
  open,
  onClose,
  peCode,
  selectedFy,
  timeline,
}: PeFyDetailDrawerVNextProps) {
  const selected = timeline.find((item) => item.fy === selectedFy);
  const marks = buildMarkRows(selected);
  // Prefer the dedicated notes column (where the sync writes conference report
  // narrative); fall back to a notes string embedded in the raw payload.
  const columnNotes =
    typeof selected?.notes === 'string' && selected.notes.trim().length > 0
      ? selected.notes.trim()
      : null;
  const notes =
    columnNotes ??
    getRawString(
      selected?.raw && typeof selected.raw === 'object'
        ? (selected.raw as Record<string, unknown>)
        : {},
      'notes',
    );
  const linkedBills = toLinkedBills(selected?.raw);
  const linkedRules = toLinkedRules(selected?.raw);
  const headerFy = selectedFy != null ? `FY${String(selectedFy).slice(-2)}` : 'FY--';

  if (!open) return null;

  return (
    <CapiroDrawer open={open} title={`${headerFy} · PE ${peCode}`} onClose={onClose}>
      <div className="pe-fb-fy-drawer">
        <section>
          <h4>1. Marks</h4>
          {marks.length === 0 ? (
            <PeFbEmpty description="No mark data for this FY" />
          ) : (
            <CapiroTableWrap>
              <CapiroTable>
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell>Mark</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Value</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Source</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Date added</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {marks.map((row) => (
                    <tr key={row.key}>
                      <CapiroTableCell>{row.label}</CapiroTableCell>
                      <CapiroTableCell>{row.value}</CapiroTableCell>
                      <CapiroTableCell>
                        {row.sourceUrl ? (
                          <a href={row.sourceUrl} target="_blank" rel="noopener noreferrer">
                            {row.sourceLabel}
                          </a>
                        ) : (
                          <span className="pe-fb-muted">{row.sourceLabel}</span>
                        )}
                      </CapiroTableCell>
                      <CapiroTableCell>{row.dateAdded}</CapiroTableCell>
                    </tr>
                  ))}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
          )}
        </section>

        <section>
          <h4>2. Conference report excerpt</h4>
          {notes ? <p>{notes}</p> : <PeFbEmpty description="No conference notes for this FY" />}
        </section>

        <section>
          <h4>3. Linked bills during cycle</h4>
          {linkedBills.length === 0 ? (
            <PeFbEmpty description="No linked bills for this FY cycle" />
          ) : (
            <ul className="pe-fb-linked-list">
              {linkedBills.map((bill) => (
                <li key={bill.id}>
                  <strong>{bill.id}</strong>, {bill.title}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4>4. Linked rules</h4>
          {linkedRules.length === 0 ? (
            <PeFbEmpty description="No linked Federal Register rules for this FY" />
          ) : (
            <ul className="pe-fb-linked-list">
              {linkedRules.map((rule) => (
                <li key={rule.id}>
                  <strong>{rule.id}</strong>, {rule.title}
                  {rule.topic ? <span className="pe-fb-muted"> ({rule.topic})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </CapiroDrawer>
  );
}
