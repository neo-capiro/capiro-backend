import { useCallback, useState } from 'react';
import { DownloadOutlined } from '@ant-design/icons';
import { message } from 'antd';
import {
  BUDGET_VEHICLE_CLASS_LABELS,
  EVIDENCE_ORIGIN_LABELS,
  FUNDING_SCOPE_LABELS,
  FUNDING_STAGE_LABELS,
  FUNDING_VERIFICATION_STATUS_LABELS,
} from '@capiro/shared';
import { fmtAmt, fmtDate, fmtDelta } from '../../components/dossier/dossier-format.js';
import type { BillDossierResponse } from './bill-360.types.js';

/**
 * Bill 360 export (Release R4, §4.5).
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
 *
 * jsPDF is a bundled dependency, dynamically imported so the ~350 kB chunk is only
 * fetched when someone actually exports (same pattern as strategy/ExportView).
 *
 * DOCX is deliberately NOT wired here. §4.5 makes it conditional ("DOCX when the
 * existing artifact service is reused"); reusing apps/api's artifact service means
 * adding an ArtifactType, a generator, a verifier entry, and a route, which is a
 * server-side change better scoped on its own than bolted onto this button.
 */

/** Human label for an evidence origin, falling back to the raw token. */
function originLabel(origin: string): string {
  return (EVIDENCE_ORIGIN_LABELS as Record<string, string>)[origin] ?? origin;
}

function labelOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/** RFC-4180 CSV cell: always quoted, embedded quotes doubled. */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

function downloadBlob(name: string, mime: string, body: BlobPart): void {
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
function slug(s: string): string {
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
      'Funding scope',
      'Amount ($M)',
      'Primary',
      'Verification',
      'Effective date',
      'Source',
      'Source page',
      'Source URL',
      'Note',
    ]),
  );
  for (const p of d.funding.positions) {
    lines.push(
      csvRow([
        // The API returns one fiscal year per bill's package; the label set carries
        // the rest of the required dimensions.
        d.funding.parentPackageLabel ?? '',
        labelOf(FUNDING_STAGE_LABELS, p.stage),
        labelOf(BUDGET_VEHICLE_CLASS_LABELS, p.vehicleClass),
        labelOf(FUNDING_SCOPE_LABELS, p.scope),
        p.amountMillions,
        p.primary ? 'yes' : 'no',
        labelOf(FUNDING_VERIFICATION_STATUS_LABELS, p.verification),
        fmtDate(p.effectiveDate),
        p.source ?? '',
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
    lines.push(
      csvRow([
        'PE code',
        'Title',
        'Request ($M)',
        'House ($M)',
        'Senate ($M)',
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
          pe.requestMillions ?? '',
          pe.houseMillions ?? '',
          pe.senateMillions ?? '',
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
  for (const k of d.kpis) p(`${k.label}: ${k.value}${k.sub ? ` — ${k.sub}` : ''}`);

  h('Overview');
  const cards: Array<[string, (typeof d.overview)['whatChanged']]> = [
    ['What changed', d.overview.whatChanged],
    ['Why it matters', d.overview.whyItMatters],
    ['Official next step', d.overview.officialNextStep],
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
    for (const pos of d.funding.positions) {
      p(
        `${labelOf(FUNDING_STAGE_LABELS, pos.stage)} · ${labelOf(BUDGET_VEHICLE_CLASS_LABELS, pos.vehicleClass)} · ${labelOf(FUNDING_SCOPE_LABELS, pos.scope)}: ${fmtAmt(pos.amountMillions)} [${labelOf(FUNDING_VERIFICATION_STATUS_LABELS, pos.verification)}]${pos.primary ? ' (primary)' : ''}`,
      );
      const src = [pos.source, pos.sourcePage != null ? `p. ${pos.sourcePage}` : null]
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

export function Bill360Export({ dossier }: { dossier: BillDossierResponse }) {
  const [busy, setBusy] = useState(false);
  const stem = slug(dossier.bill.num || dossier.bill.id);

  const onCsv = useCallback(() => {
    const generatedAt = new Date().toISOString();
    downloadBlob(
      `capiro-bill360-${stem}-funding.csv`,
      'text/csv;charset=utf-8',
      // BOM so Excel reads the UTF-8 scope labels correctly.
      `﻿${buildFundingCsv(dossier, generatedAt)}`,
    );
  }, [dossier, stem]);

  const onPdf = useCallback(async () => {
    setBusy(true);
    try {
      const generatedAt = new Date().toISOString();
      const lines = buildFactSheetLines(dossier, generatedAt);
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
      const marginX = 48;
      const marginTop = 56;
      const bottom = pdf.internal.pageSize.getHeight() - 48;
      const width = pdf.internal.pageSize.getWidth() - marginX * 2;
      let y = marginTop;

      for (const line of lines) {
        pdf.setFont('helvetica', line.heading ? 'bold' : 'normal');
        pdf.setFontSize(line.heading ? 12 : 9.5);
        if (line.heading) y += 8;
        for (const wrapped of pdf.splitTextToSize(line.text, width) as string[]) {
          if (y > bottom) {
            pdf.addPage();
            y = marginTop;
          }
          pdf.text(wrapped, marginX, y);
          y += line.heading ? 16 : 13;
        }
      }
      pdf.save(`capiro-bill360-${stem}-fact-sheet.pdf`);
    } catch (err) {
      message.error(`Could not build the PDF: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [dossier, stem]);

  return (
    <span className="dsr-export">
      <button type="button" className="dsr-btn" onClick={onPdf} disabled={busy}>
        <DownloadOutlined /> {busy ? 'Building…' : 'Fact sheet (PDF)'}
      </button>
      <button type="button" className="dsr-btn" onClick={onCsv}>
        <DownloadOutlined /> Funding (CSV)
      </button>
    </span>
  );
}
