import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ComprehensiveBriefing } from './meeting-prep-comprehensive.js';
import { MEETING_BRIEFING_SECTIONS, type MeetingBriefingSection } from './meeting-prep-policy.js';

export interface PrepPdfSection {
  heading: string;
  body?: string;
  items?: string[];
  ordered?: boolean;
}

/** Mirrors ComprehensivePrep.tsx so the emailed PDF reads like the screen. */
export const BRIEFING_SECTION_LABELS: Record<MeetingBriefingSection, string> = {
  recentDevelopments: 'Recent developments',
  importantEmails: 'Important email exchanges',
  previousConversations: 'Previous meetings and conversations',
  decisions: 'Decisions already made',
  unresolvedIssues: 'Outstanding questions and unresolved issues',
  upcomingDevelopments: 'Upcoming deadlines, meetings and legislative developments',
  commitments: 'What we committed to doing',
};

/** The prep exactly as the Prep tab lays it out — without the source appendix. */
export function meetingPrepPdfSections(prep: {
  summary: string | null;
  agenda: unknown;
  talkingPoints: unknown;
  risks: unknown;
  followUps: unknown;
  emailEvidence: unknown;
  generatedFrom: unknown;
}): PrepPdfSection[] {
  const generatedFrom = asRecord(prep.generatedFrom);
  const grounding = asRecord(generatedFrom.grounding);
  // Edited text no longer matches the structured briefing, so the saved fields win.
  const briefing =
    grounding.contentEdited === true
      ? null
      : ((generatedFrom.briefing as ComprehensiveBriefing | undefined) ?? null);
  if (briefing?.version === 2) {
    return [
      { heading: 'Key takeaways', items: briefing.takeaways.map((item) => item.text) },
      ...MEETING_BRIEFING_SECTIONS.map((key) => ({
        heading: BRIEFING_SECTION_LABELS[key],
        items: briefing.sections[key]?.items.map((item) => item.text) ?? [],
        body: briefing.sections[key]?.gap ?? '',
      })),
    ];
  }
  return [
    { heading: 'Summary', body: prep.summary ?? '' },
    { heading: 'Agenda', items: strings(prep.agenda) },
    { heading: 'Talking Points', items: strings(prep.talkingPoints), ordered: true },
    { heading: 'Watch-outs', items: strings(prep.risks) },
    { heading: 'Follow-ups', items: strings(prep.followUps) },
    { heading: 'Email evidence', items: strings(prep.emailEvidence) },
  ];
}

/** The saved prep lists are JSON columns; only their string entries are printable. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const TEXT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.48, 0.46, 0.42);
// Standard fonts are WinAnsi-only; anything outside that set would throw at encode time.
const WIN_ANSI = /[^\x20-\x7e\xa0-\xffŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/g;

function printable(value: string): string {
  return value.replace(/\s+/g, ' ').replace(WIN_ANSI, '?').trim();
}

class PageWriter {
  private page: PDFPage;
  private y = PAGE_HEIGHT - MARGIN;

  constructor(private readonly pdf: PDFDocument) {
    this.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }

  gap(points: number): void {
    this.y -= points;
  }

  text(value: string, font: PDFFont, size: number, color = INK, indent = 0): void {
    const lineHeight = size * 1.4;
    for (const line of wrap(printable(value), font, size, TEXT_WIDTH - indent)) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font, color });
      this.y -= lineHeight;
    }
  }

  bullet(marker: string, value: string, font: PDFFont, size: number): void {
    const indent = 18;
    this.ensure(size * 1.4);
    const top = this.y;
    this.text(value, font, size, INK, indent);
    this.page.drawText(marker, { x: MARGIN, y: top - size, size, font, color: INK });
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN) {
      this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }
}

function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  const fits = (candidate: string) => font.widthOfTextAtSize(candidate, size) <= maxWidth;
  for (const word of value.split(' ').filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    // A single token wider than the line (a URL, an identifier) is split by characters.
    let rest = word;
    while (rest && !fits(rest)) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export async function renderMeetingPrepPdf(document: {
  title: string;
  subtitle: string;
  sections: PrepPdfSection[];
}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(printable(document.title));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const writer = new PageWriter(pdf);
  writer.text(document.title, bold, 18);
  writer.gap(2);
  if (document.subtitle.trim()) writer.text(document.subtitle, regular, 11, MUTED);
  for (const section of document.sections) {
    const items = (section.items ?? []).filter((item) => item.trim());
    const body = section.body?.trim() ?? '';
    if (!items.length && !body) continue;
    writer.gap(14);
    writer.text(section.heading.toUpperCase(), bold, 9, MUTED);
    writer.gap(4);
    if (items.length) {
      items.forEach((item, index) =>
        writer.bullet(section.ordered ? `${index + 1}.` : '•', item, regular, 11),
      );
    } else {
      writer.text(body, regular, 11);
    }
  }
  return Buffer.from(await pdf.save());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
