import type { ExtractedFundingRow, FundingCandidate, ParseResult } from './community-funding.types.js';
import { normalizeCommunityFundingGeography } from './community-funding.geography.js';

export const US_STATE_CODES = new Set('AL AK AS AZ AR CA CO CT DE DC FL GA GU HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND MP OH OK OR PA PR RI SC SD TN TX UT VT VA VI WA WV WI WY'.split(' '));
const clean = (v: string) => v.replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();

export function normalizeIdentityText(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function parseUsd(value: string): string | null {
  const raw = value.trim();
  const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw);
  const body = raw.replace(/[\s$(),]/g, '').replace(/^-/, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(body) || negative) return null;
  return Number(body).toFixed(2);
}

function location(raw: string): { city: string | null; state: string | null; zip: string | null } {
  const m = clean(raw).match(/^(.*?)(?:,\s*)?([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
  if (!m || !US_STATE_CODES.has(m[2]!)) return { city: null, state: null, zip: null };
  return { city: m[1]?.trim() || null, state: m[2]!, zip: m[3] ?? null };
}

function parseRows(rows: ExtractedFundingRow[], fiscalYear: number, kind: 'house' | 'senate', subcommittee: string | null): ParseResult {
  const expected = kind === 'house' ? 7 : 6;
  const candidates: FundingCandidate[] = [], rejected: ParseResult['rejected'] = [], warnings: string[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (item.columns.length !== expected) { rejected.push({ page: item.page, row: item.row, reason: `expected ${expected} columns, received ${item.columns.length}` }); continue; }
    const c = item.columns.map(clean);
    const amountIndex = kind === 'house' ? 5 : 4;
    const amount = parseUsd(c[amountIndex]!);
    if (amount === null) { rejected.push({ page: item.page, row: item.row, reason: `invalid or negative amount: ${c[amountIndex]}` }); continue; }
    const stateRaw = kind === 'house' ? location(c[4]!).state : c[1]!.toUpperCase();
    if (stateRaw && !US_STATE_CODES.has(stateRaw)) { rejected.push({ page: item.page, row: item.row, reason: `invalid state code: ${stateRaw}` }); continue; }
    const loc = kind === 'house' ? location(c[4]!) : { city: null, state: stateRaw || null, zip: null };
    const candidate: FundingCandidate = kind === 'house' ? {
      chamber: 'house', requestType: 'cpf', fiscalYear, requesterName: c[6]!, requesterState: null,
      requesterDistrict: null, recipientName: c[2]!, recipientAddress: null, ...loc,
      projectTitle: c[3]!, projectDescription: null, requestedAmountUsd: amount, finalAmountUsd: null,
      amountStageRaw: 'house_amount', appropriationsAccountRaw: [c[0], c[1]].filter(Boolean).join(' / '), subcommittee,
      sourcePage: item.page, sourceRow: item.row,
    } : {
      chamber: 'senate', requestType: 'cds', fiscalYear, requesterName: c[5]!, requesterState: stateRaw || null,
      requesterDistrict: null, recipientName: c[3]!, recipientAddress: null, city: null, state: stateRaw || null, zip: null,
      projectTitle: c[2]!, projectDescription: null, requestedAmountUsd: amount, finalAmountUsd: null,
      amountStageRaw: 'senate_recommendation', appropriationsAccountRaw: c[0]!, subcommittee,
      sourcePage: item.page, sourceRow: item.row,
    };
    if (!candidate.requesterName || !candidate.recipientName || !candidate.projectTitle) { rejected.push({ page: item.page, row: item.row, reason: 'missing required text field' }); continue; }
    const fingerprint = JSON.stringify(candidate);
    if (seen.has(fingerprint)) { warnings.push(`duplicate row ${item.row} on page ${item.page}`); continue; }
    seen.add(fingerprint); candidates.push(candidate);
  }
  return { candidates, rejected, warnings };
}

export const parseHousePdfRows = (rows: ExtractedFundingRow[], fy: number, subcommittee: string | null = null) => parseRows(rows, fy, 'house', subcommittee);
export const parseSenatePdfRows = (rows: ExtractedFundingRow[], fy: number, subcommittee: string | null = null) => parseRows(rows, fy, 'senate', subcommittee);

export function parseHouseXlsxRows(rows: Record<string, unknown>[], fiscalYear: number): ParseResult {
  const candidates: FundingCandidate[] = [], rejected: ParseResult['rejected'] = [];
  rows.forEach((row, index) => {
    const amount = parseUsd(String(row['Amount Requested'] ?? ''));
    if (!amount) { rejected.push({ page: null, row: index + 2, reason: 'invalid or negative Amount Requested' }); return; }
    const recipient = clean(String(row.Recipient ?? '')), project = clean(String(row['Project Description'] ?? ''));
    const requester = clean(`${row['Member First Name'] ?? ''} ${row['Member Last Name'] ?? ''}`);
    if (!recipient || !project || !requester) { rejected.push({ page: null, row: index + 2, reason: 'missing required text field' }); return; }
    const rawDistrict = clean(String(row.District ?? '')) || null;
    const normalizedDistrict = rawDistrict?.toUpperCase() ?? null;
    const geography = normalizeCommunityFundingGeography({ chamber: 'house', requesterState: null, requesterDistrict: normalizedDistrict, projectState: null });
    if (geography.conflictReason) { rejected.push({ page: null, row: index + 2, reason: geography.conflictReason }); return; }
    candidates.push({ chamber: 'house', requestType: 'cpf', fiscalYear, requesterName: requester, requesterState: geography.state,
      requesterDistrict: normalizedDistrict, recipientName: recipient,
      recipientAddress: clean(String(row['Recipient Address'] ?? '')) || null, city: null, state: null, zip: null,
      projectTitle: project, projectDescription: null, requestedAmountUsd: amount, finalAmountUsd: null,
      amountStageRaw: 'amount_requested', appropriationsAccountRaw: null,
      subcommittee: clean(String(row.Subcommittee ?? '')) || null, sourcePage: null, sourceRow: index + 2 });
  });
  return { candidates, rejected, warnings: [] };
}
