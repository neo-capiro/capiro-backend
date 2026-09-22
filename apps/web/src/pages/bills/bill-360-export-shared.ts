import {
  BUDGET_VEHICLE_CLASS_LABELS,
  EVIDENCE_ORIGIN_LABELS,
  FUNDING_SCOPE_LABELS,
  FUNDING_STAGE_LABELS,
  FUNDING_VERIFICATION_STATUS_LABELS,
} from '@capiro/shared';
import { fmtAmt, fmtDate, fmtDelta } from '../../components/dossier/dossier-format.js';
import { kpiSubText, kpiValueText, orderedKpis } from './bill-360-kpis.js';
import type { BillDossierResponse } from './bill-360.types.js';

/**
 * Bill 360 export builders (Release R4, §4.5) — the UI-free half of
 * Bill360Export.tsx, extracted so the vNext surface can reuse them without
 * touching the antd-based button/toast chrome (extraction pattern: the legacy
 * file re-exports these, its public API unchanged).
 *
 * Two artifacts, both generated client-side from the dossier already on screen — so
 * an export can never disagree with what the analyst just read:
 *
 *   - **Fact sheet (PDF)** — identity, canonical status, KPIs, overview cards with
 *     their provenance labels, the legislative path, recorded votes, governing rules,
 *     funding positions, and the full source list.
 *   - **Funding comparison (CSV)** — one row per funding position, every row carrying
 *     fiscal year, stage, vehicle class, scope, verification status, and source.
 *
 * EVERY export carries (§4.5): a generated timestamp, the bill and client context,
 * the source list, Official / Capiro analysis / Analyst outlook labels, and
 * fiscal-year / vehicle / stage / scope labels. Nothing is summarized or inferred at
 * export time — the exporter only formats what the API returned.
 */

/** Human label for an evidence origin, falling back to the raw token. */
function originLabel(origin: string): string {
  return (EVIDENCE_ORIGIN_LABELS as Record<string, string>)[origin] ?? origin;
}

function labelOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

function amountTreatmentLabel(treatment: string | null | undefined): string {
  switch (treatment) {
    case 'proposed_authorization':
      return 'Proposed authorization level — not appropriated funding';
    case 'appropriated_funding':
      return 'Appropriated funding';
    case 'request':
      return 'Executive budget request';
    case 'unknown':
    case null:
    case undefined:
      return 'Funding treatment not verified';
    default:
      return treatment.replaceAll('_', ' ');
  }
}

/** RFC-4180 CSV cell: always quoted, embedded quotes doubled. */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export function downloadBlob(name: string, mime: string, body: BlobPart): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** `H.R. 8800` → `hr-8800` for a filesystem-safe filename stem. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The funding-comparison CSV (§4.5). Exported for the unit test: the header contract
 * is the guarantee that no amount ever leaves Capiro without its scope and source.
 */
export function buildFundingCsv(d: BillDossierResponse, generatedAt: string): string {
  const lines: string[] = [];
  // Provenance preamble — a spreadsheet that outlives this session still says what it
  // is, when it was made, and for whom.
  lines.push(csvRow(['Capiro Bill 360 — funding comparison']));
  lines.push(csvRow(['Bill', `${d.bill.num} — ${d.bill.title}`]));
  lines.push(csvRow(['Canonical status', `${d.bill.statusLabel}${d.bill.statusAt ? ` (${fmtDate(d.bill.statusAt)})` : ''}`]));
  lines.push(csvRow(['Context', d.context ? `${d.context.contextType}: ${d.context.name}` : 'Global (public dossier)']));
  lines.push(csvRow(['Generated at', generatedAt]));
  lines.push(csvRow(['Last synced', fmtDate(d.provenance.lastSyncedAt) || 'unknown']));
  lines.push(
    csvRow([
      'Comparability rule',
      'Amounts are only comparable within the same fiscal year AND the same funding scope. Rows on different scopes are different measurements and must not be subtracted.',
    ]),
  );
  if (d.funding.overrideReconciliation === 'reconciled') {
    lines.push(
      csvRow([
        'Override reconciliation',
        "Verified against the bill's amount-changing provisions",
      ]),
    );
  }
  if (!d.funding.available) {
    lines.push(csvRow([]));
    lines.push(csvRow(['Funding data', d.funding.status ?? 'Not available']));
    return lines.join('\r\n');
  }
  lines.push(csvRow([]));
  lines.push(
    csvRow([
      'Fiscal year',
      'Stage',
      'Vehicle class',
      'Vehicle track',
      'Amount treatment',
      'Funding scope',
      'Amount ($M)',
      'Primary',
      'Verification',
      'Effective date',
      'Source',
      'Source document',
      'Source key',
      'Source version (SHA-256)',
      'Current source version',
      'Source page',
      'Source URL',
      'Note',
    ]),
  );
  for (const p of d.funding.positions) {
    lines.push(
      csvRow([
        p.fiscalYear ?? d.funding.vehicle?.fiscalYear ?? '',
        labelOf(FUNDING_STAGE_LABELS, p.stage),
        labelOf(BUDGET_VEHICLE_CLASS_LABELS, p.vehicleClass),
        p.vehicleTrack
          ? labelOf(BUDGET_VEHICLE_CLASS_LABELS, p.vehicleTrack)
          : 'Not verified',
        amountTreatmentLabel(p.amountTreatment),
        labelOf(FUNDING_SCOPE_LABELS, p.scope),
        p.amountMillions,
        p.primary ? 'yes' : 'no',
        labelOf(FUNDING_VERIFICATION_STATUS_LABELS, p.verification),
        fmtDate(p.effectiveDate),
        p.source ?? '',
        p.sourceDocumentTitle ?? '',
        p.sourceDocumentKey ?? '',
        p.sourceDocumentVersion ?? '',
        p.sourceDocumentCurrent == null ? '' : p.sourceDocumentCurrent ? 'yes' : 'no',
        p.sourcePage ?? '',
        p.sourceUrl ?? '',
        p.note ?? '',
      ]),
    );
  }
  if (d.funding.reqCompare) {
    lines.push(csvRow([]));
    lines.push(csvRow(['Delta vs request — SAME fiscal year and SAME scope only']));
    lines.push(csvRow(['Scope', 'Request ($M)', 'Delta ($M)', 'Delta %']));
    lines.push(
      csvRow([
        labelOf(FUNDING_SCOPE_LABELS, d.funding.reqCompare.scope),
        d.funding.reqCompare.amountMillions ?? '',
        d.funding.reqCompare.deltaMillions ?? '',
        d.funding.reqCompare.pct ?? '',
      ]),
    );
  }
  if (d.funding.programElementImpacts.length) {
    lines.push(csvRow([]));
    lines.push(csvRow(['Program Element impacts']));
    const track = d.funding.programElementImpacts[0]?.vehicleTrack;
    const houseLabel =
      d.funding.programElementImpacts[0]?.houseLabel ??
      (track === 'authorization'
        ? 'House authorization (HASC)'
        : track === 'appropriation'
          ? 'House appropriation (HAC-D)'
          : 'House amount (track not verified)');
    const senateLabel =
      d.funding.programElementImpacts[0]?.senateLabel ??
      (track === 'authorization'
        ? 'Senate authorization (SASC)'
        : track === 'appropriation'
          ? 'Senate appropriation (SAC-D)'
          : 'Senate amount (track not verified)');
    const conferenceLabel =
      d.funding.programElementImpacts[0]?.conferenceLabel ??
      (track === 'authorization'
        ? 'NDAA conference authorization'
        : track === 'appropriation'
          ? 'Appropriations conference'
          : 'Conference amount (track not verified)');
    lines.push(
      csvRow([
        'PE code',
        'Title',
        'Fiscal year',
        'Track',
        'Request ($M)',
        `${houseLabel} ($M)`,
        `${senateLabel} ($M)`,
        `${conferenceLabel} ($M)`,
        'Enacted appropriation ($M)',
        'Delta vs request ($M)',
        'Delta %',
        'Match basis',
        'Source',
      ]),
    );
    for (const pe of d.funding.programElementImpacts) {
      lines.push(
        csvRow([
          pe.pe,
          pe.name ?? '',
          pe.fiscalYear ?? '',
          pe.vehicleTrack ?? 'Not verified',
          pe.requestMillions ?? '',
          pe.houseMillions ?? '',
          pe.senateMillions ?? '',
          pe.conferenceMillions ?? '',
          pe.enactedMillions ?? '',
          pe.deltaVsRequestMillions ?? '',
          pe.pct ?? '',
          pe.basis === 'explicit' ? 'Explicit PE match' : 'Inferred match',
          pe.source ?? '',
        ]),
      );
    }
  }
  lines.push(csvRow([]));
  lines.push(csvRow(['Sources']));
  lines.push(csvRow(['Provenance', 'Source', 'As of', 'Freshness', 'URL']));
  for (const s of d.provenance.sources) {
    lines.push(
      csvRow([originLabel(s.origin), s.label, fmtDate(s.as), s.fresh ? 'Current' : 'Stale', s.url ?? '']),
    );
  }
  return lines.join('\r\n');
}

/**
 * The fact-sheet line model (§4.5). Exported so the test can assert the provenance
 * labels and the comparability caveat without rendering a PDF.
 */
export function buildFactSheetLines(
  d: BillDossierResponse,
  generatedAt: string,
): Array<{ text: string; heading?: boolean }> {
  const out: Array<{ text: string; heading?: boolean }> = [];
  const h = (text: string) => out.push({ text, heading: true });
  const p = (text: string) => out.push({ text });

  h(`${d.bill.num} — ${d.bill.title}`);
  p(`Canonical status: ${d.bill.statusLabel}${d.bill.statusAt ? ` (as of ${fmtDate(d.bill.statusAt)})` : ''}`);
  p(
    [
      d.bill.chamber,
      d.bill.type ? `${d.bill.type.toUpperCase()} bill` : null,
      d.bill.sponsor ? `Sponsor: ${d.bill.sponsor}` : null,
      d.bill.jurisdiction ? `Jurisdiction: ${d.bill.jurisdiction}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  p(`Context: ${d.context ? `${d.context.contextType} — ${d.context.name}` : 'Global (public dossier)'}`);
  p(`Generated at: ${generatedAt}`);
  p(`Last synced: ${fmtDate(d.provenance.lastSyncedAt) || 'unknown'}`);

  h('Key figures');
  for (const k of orderedKpis(d.kpis)) {
    const sub = kpiSubText(k);
    // PDF-only label: the shared KPI strip's "Δ from request" cell uses the Greek
    // Δ, which jsPDF's built-in Helvetica cannot encode (it renders as a curly
    // quote — see native-bill360-root/fact-sheet-page-1.png). The UI strip keeps
    // the compact Δ; the fact sheet spells it out so the printed KPI is readable.
    // Substitution is keyed on the cell's stable semantic id (delta_from_request),
    // never on the display string, so a re-label elsewhere can't break this.
    const label = k.id === 'delta_from_request' ? 'Change from request' : k.label;
    p(`${label}: ${kpiValueText(k)}${sub ? ` — ${sub}` : ''}`);
  }

  h('Overview');
  const cards: Array<[string, (typeof d.overview)['whatChanged']]> = [
    ['What changed', d.overview.whatChanged],
    ['Why it matters', d.overview.whyItMatters],
    ['Procedural posture', d.overview.officialNextStep],
    ['Analyst outlook', d.overview.analystOutlook],
  ];
  for (const [title, v] of cards) {
    if (!v) continue;
    // The provenance label travels WITH the sentence — an exported PDF is read out
    // of context, so an analyst forecast must never look like an official fact.
    p(`[${originLabel(v.origin)}] ${title}: ${v.text}`);
    const meta = [v.asOf ? `As of ${fmtDate(v.asOf)}` : null, v.source, v.expires ? `Valid to ${fmtDate(v.expires)}` : null]
      .filter(Boolean)
      .join(' · ');
    if (meta) p(`    ${meta}`);
  }

  if (d.governingRules.length) {
    h('Governing rules');
    for (const r of d.governingRules) {
      p(
        `${r.label}: rule ${r.result ?? '—'} ${r.tally}${r.date ? ` (${fmtDate(r.date)})` : ''}${r.controls ? ' — controls displayed status' : ''}`,
      );
      if (r.note) p(`    ${r.note}`);
    }
  }

  h('Recorded votes');
  if (d.votes.length) {
    for (const v of d.votes) {
      p(`${v.label} — ${v.result ?? '—'} ${v.tally}${v.date ? ` (${fmtDate(v.date)})` : ''}`);
    }
  } else {
    p(d.noVote ?? 'No recorded votes.');
  }
  // The explicit "no roll call" statement travels even when other votes exist.
  if (d.votes.length && d.noVote) p(d.noVote);

  if (d.milestones.length) {
    h('Legislative path');
    for (const m of d.milestones.slice(0, 12)) {
      p(`${fmtDate(m.date) || '—'} — ${m.label}${m.state === 'failed' ? ' [FAILED]' : ''}`);
    }
  }

  h('Funding');
  if (!d.funding.available) {
    p(d.funding.status ?? 'No funding data available.');
  } else {
    p(
      'Amounts are only comparable within the same fiscal year AND the same funding scope.',
    );
    if (d.funding.analysisStatus === 'analysis_pending') {
      const vehicle = d.funding.vehicle;
      p(
        `${vehicle ? `${labelOf(FUNDING_STAGE_LABELS, vehicle.stage)} ${labelOf(BUDGET_VEHICLE_CLASS_LABELS, vehicle.track).toLowerCase()}` : 'Funding analysis'}: Analysis pending`,
      );
      p(d.funding.status ?? 'Funding tables are available; amounts await verification.');
      if (vehicle) {
        p(
          `    FY${vehicle.fiscalYear} · ${amountTreatmentLabel(vehicle.amountTreatment)} · Source: ${[
            vehicle.sourceDocumentTitle ?? vehicle.label,
            vehicle.sourceDocumentKey,
            vehicle.sourceDocumentVersion
              ? `version ${vehicle.sourceDocumentVersion.slice(0, 12)}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}`,
        );
      }
    }
    for (const pos of d.funding.positions) {
      p(
        `${labelOf(FUNDING_STAGE_LABELS, pos.stage)} · ${labelOf(BUDGET_VEHICLE_CLASS_LABELS, pos.vehicleClass)} · ${labelOf(FUNDING_SCOPE_LABELS, pos.scope)}: ${fmtAmt(pos.amountMillions)} [${labelOf(FUNDING_VERIFICATION_STATUS_LABELS, pos.verification)}]${pos.primary ? ' (primary)' : ''} — ${amountTreatmentLabel(pos.amountTreatment)}`,
      );
      const src = [
        pos.sourceDocumentTitle ?? pos.source,
        pos.sourceDocumentKey,
        pos.sourceDocumentVersion ? `version ${pos.sourceDocumentVersion.slice(0, 12)}` : null,
        pos.sourcePage != null ? `p. ${pos.sourcePage}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (src) p(`    Source: ${src}`);
    }
    if (d.funding.reqCompare?.deltaMillions != null) {
      p(
        `Delta vs request (${labelOf(FUNDING_SCOPE_LABELS, d.funding.reqCompare.scope)}): ${fmtDelta(d.funding.reqCompare.deltaMillions)}`,
      );
    }
    if (d.funding.guardrail) p(d.funding.guardrail);
    if (d.funding.overrideReconciliation === 'reconciled') {
      p("Override reconciliation: Verified against the bill's amount-changing provisions.");
    }
    if (d.funding.parentPackageLabel) p(`Part of ${d.funding.parentPackageLabel}`);
  }

  h('Sources');
  for (const s of d.provenance.sources) {
    p(
      `[${originLabel(s.origin)}] ${s.label}${s.as ? ` — as of ${fmtDate(s.as)}` : ''} (${s.fresh ? 'current' : 'stale'})${s.url ? ` ${s.url}` : ''}`,
    );
  }
  p('Generated by Capiro Bill 360. Official / Capiro analysis / Analyst outlook labels are shown in brackets.');
  return out;
}
