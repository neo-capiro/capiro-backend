import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ReportCardData } from './report-card.service.js';

/**
 * Renders a client Report Card as a Word document — client-ready output for
 * the Intelligence tab's "Export profile" action (Federal Footprint), which
 * previously had no onClick at all. Mirrors the established `docx`-lib
 * letterhead/section/footer approach already used in this same service
 * (alert-memo-docx.ts) rather than inventing a second document style; a
 * report card is a data summary, not a multi-page executive report, so it
 * does not need the Strategies exporter's raster-image branding machinery —
 * a text letterhead naming the ACTUAL tenant (not a hardcoded vendor name)
 * is what every other real value on this page already assumes: real data
 * only, no invented content.
 */

const NAVY = '1C2E4A';
const GOLD = '9F7518';
const GREY = '6B7280';
const RULE = 'D0D5DD';

export const REPORT_CARD_DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** `{client}-report-card-{period}.docx`, filesystem-safe. */
export function reportCardFilename(data: ReportCardData): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'client';
  const dateStamp = data.period.end.toISOString().slice(0, 10);
  return `${slug(data.client.name)}-report-card-${dateStamp}.docx`;
}

function usd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

function rangeDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function rule(): Paragraph {
  return new Paragraph({
    spacing: { after: 200 },
    border: { bottom: { color: GOLD, style: BorderStyle.SINGLE, size: 12, space: 1 } },
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, color: NAVY })],
  });
}

function metaLine(label: string, value: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, color: NAVY }),
      new TextRun({ text: value }),
    ],
  });
}

function statLine(label: string, value: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    bullet: { level: 0 },
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: value }),
    ],
  });
}

/** Simple two-column table — used for the weekly health trend, the only
 * series-shaped data this report carries. No chart: a table of real numbers
 * beats a rendered graphic neither this service nor the `docx` lib builds
 * today, and is honest about being exactly what it is. */
function table(headers: [string, string], rows: Array<[string, string]>): Table {
  const headerRow = new TableRow({
    children: headers.map(
      (h) =>
        new TableCell({
          width: { size: 50, type: WidthType.PERCENTAGE },
          shading: { fill: 'F2F0EB' },
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18 })] })],
        }),
    ),
  });
  const bodyRows = rows.map(
    ([a, b]) =>
      new TableRow({
        children: [a, b].map(
          (v) =>
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: v, size: 18 })] })],
            }),
        ),
      }),
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
}

export async function renderReportCardDocx(data: ReportCardData): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  // ---- Letterhead — the ACTUAL tenant, never a hardcoded vendor name. A
  // report card is produced BY a tenant FOR its client; "Capiro" is the
  // platform, not the government-affairs firm using it. ----
  children.push(
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({ text: (data.tenant.name || 'Report').toUpperCase(), bold: true, size: 30, color: NAVY }),
        new TextRun({ text: '   Client Report Card', bold: true, size: 16, color: GOLD }),
      ],
    }),
  );
  children.push(rule());

  // ---- Title + meta ----
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: data.client.name, bold: true, size: 26, color: NAVY })],
    }),
  );
  children.push(metaLine('Period', data.period.label));
  children.push(
    metaLine(
      'Generated',
      new Date(data.generatedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    ),
  );
  if (data.client.sectorTag) children.push(metaLine('Sector', data.client.sectorTag));
  children.push(
    new Paragraph({ spacing: { after: 160 }, border: { bottom: { color: RULE, style: BorderStyle.SINGLE, size: 6, space: 6 } } }),
  );

  // ---- Activity ----
  children.push(sectionHeading('Activity'));
  children.push(statLine('Meetings', String(data.activity.meetings)));
  if (data.activity.uniqueRoles.length) {
    children.push(statLine('Attendee roles engaged', data.activity.uniqueRoles.join(', ')));
  }
  children.push(
    statLine(
      'Outreach sent',
      `${data.activity.outreachSent}${
        data.activity.outreachSent > 0
          ? ` (${Math.round(data.activity.outreachOpenRate * 100)}% opened)`
          : ''
      }`,
    ),
  );
  children.push(statLine('Tasks completed', String(data.activity.tasksCompleted)));
  children.push(statLine('Debriefs filed', String(data.activity.debriefsFiled)));
  children.push(statLine('Mail threads active', String(data.activity.mailThreads)));

  // ---- Intelligence ----
  children.push(sectionHeading('Intelligence'));
  children.push(statLine('Bills tracked', String(data.intelligence.billsTracked)));
  const billStatusEntries = Object.entries(data.intelligence.billsByStatus);
  if (billStatusEntries.length) {
    children.push(
      statLine('By status', billStatusEntries.map(([status, count]) => `${status}: ${count}`).join(', ')),
    );
  }
  children.push(statLine('Competitor filings tracked', String(data.intelligence.competitorCount)));
  // A confirmed $0 is a real reported figure; only the absence of a mapping
  // (handled upstream, before this renderer ever sees the data) is "—".
  children.push(statLine('Lobby spend (all-time, confirmed mapping)', usd(data.intelligence.lobbySpend)));
  children.push(statLine('Contract wins (all-time, confirmed mapping)', usd(data.intelligence.contractWins)));

  // ---- Outcomes ----
  children.push(sectionHeading('Outcomes this period'));
  if (data.outcomes.length === 0) {
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: 'No outcomes recorded for this period.', italics: true, color: GREY })],
      }),
    );
  } else {
    for (const o of data.outcomes) {
      const detail = [o.capability, `FY${o.fiscalYear}`].filter(Boolean).join(' · ');
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 40 },
          children: [
            new TextRun({ text: `${o.title} — ${o.outcomeType}`, bold: true }),
            new TextRun({ text: detail ? `  (${detail})` : '' }),
          ],
        }),
      );
      if (o.notes) {
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            indent: { left: 360 },
            children: [new TextRun({ text: o.notes, size: 18, color: GREY })],
          }),
        );
      }
    }
  }

  // ---- Engagement health trend ----
  if (data.healthTrend.length > 0) {
    children.push(sectionHeading('Engagement health trend'));
    children.push(
      table(
        ['Week ending', 'Score'],
        data.healthTrend.map((w) => [w.week, String(w.score)]),
      ),
    );
  }

  // ---- Forward look ----
  if (data.aiForwardLook) {
    children.push(sectionHeading('Forward look'));
    for (const paragraph of data.aiForwardLook.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
      children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(paragraph)] }));
    }
  }

  // ---- Footer ----
  children.push(
    new Paragraph({
      spacing: { before: 260 },
      border: { top: { color: RULE, style: BorderStyle.SINGLE, size: 6, space: 6 } },
      children: [
        new TextRun({
          text: `Prepared by ${data.tenant.name || 'this firm'} · Confidential — for internal client use`,
          italics: true,
          size: 16,
          color: GREY,
        }),
      ],
    }),
  );

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
