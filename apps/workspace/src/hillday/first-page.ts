import { BadRequestException } from '@nestjs/common';
import {
  COVER_FACT_KEYS,
  SUMMARY_COLUMN_KEYS,
  type CoverFactKey,
  type FirstPageEdits,
  type HillDayDocumentView,
  type SummaryColumnKey,
  type SummaryRow,
} from './hillday.types.js';

const ROW_LIMITS: Record<SummaryColumnKey, number> = {
  time: 80, member: 300, office: 300, room: 500, minutes: 40, staffLead: 300,
};

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${label} must be an object`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new BadRequestException(`${label} contains an unknown field`);
  return row;
}

function string(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) throw new BadRequestException(`${label} must be text of at most ${max} characters`);
  return value;
}

function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new BadRequestException(`${label} must contain at most ${max} items`);
  return value;
}

/** Validate at the service boundary too: nested optional DTO fields allow null. */
export function validateFirstPage(value: unknown, meetingIds: ReadonlySet<string>): FirstPageEdits | null {
  if (value === null) return null;
  const input = object(value, ['title', 'dateline', 'facts', 'rows', 'hiddenColumns'], 'First page');
  const result: FirstPageEdits = {};
  if (input.title !== undefined) result.title = string(input.title, 200, 'Title');
  if (input.dateline !== undefined) result.dateline = string(input.dateline, 1000, 'Dateline');
  if (input.facts !== undefined) {
    const seen = new Set<string>();
    result.facts = array(input.facts, 6, 'Cover facts').map((value) => {
      const fact = object(value, ['key', 'value'], 'Cover fact');
      const key = string(fact.key, 64, 'Cover fact key');
      if (!COVER_FACT_KEYS.includes(key as CoverFactKey) || seen.has(key)) throw new BadRequestException('Cover facts must use unique supported keys');
      seen.add(key);
      return { key: key as CoverFactKey, value: string(fact.value, 500, 'Cover fact') };
    });
  }
  if (input.rows !== undefined) {
    const seen = new Set<string>();
    result.rows = array(input.rows, 80, 'Schedule rows').map((value) => {
      const row = object(value, ['meetingId', ...SUMMARY_COLUMN_KEYS], 'Schedule row');
      const meetingId = string(row.meetingId, 64, 'Meeting ID');
      if (!meetingIds.has(meetingId) || seen.has(meetingId)) throw new BadRequestException('Schedule rows must use unique meetings from this document');
      seen.add(meetingId);
      const result: NonNullable<FirstPageEdits['rows']>[number] = { meetingId };
      for (const key of SUMMARY_COLUMN_KEYS) if (row[key] !== undefined) result[key] = string(row[key], ROW_LIMITS[key], key);
      return result;
    });
  }
  if (input.hiddenColumns !== undefined) {
    const hidden = array(input.hiddenColumns, 5, 'Hidden columns');
    if (new Set(hidden).size !== hidden.length || hidden.some((key) => !SUMMARY_COLUMN_KEYS.includes(key as SummaryColumnKey))) {
      throw new BadRequestException('Hidden columns must use unique supported keys; keep at least one column visible');
    }
    result.hiddenColumns = hidden as SummaryColumnKey[];
  }
  return result;
}

export function hasFirstPageEdits(firstPage: FirstPageEdits | null): boolean {
  return Boolean(firstPage && (firstPage.title !== undefined || firstPage.dateline !== undefined ||
    firstPage.facts?.length || firstPage.rows?.some((row) => Object.keys(row).length > 1) || firstPage.hiddenColumns?.length));
}

export function applyFirstPage(
  cover: HillDayDocumentView['cover'],
  summary: SummaryRow[],
  edits: FirstPageEdits | null,
): Pick<HillDayDocumentView, 'cover' | 'summary' | 'summaryColumns'> {
  const facts = new Map(edits?.facts?.map((f) => [f.key, f.value]) ?? []);
  const rows = new Map(edits?.rows?.map((r) => [r.meetingId, r]) ?? []);
  const hidden = new Set(edits?.hiddenColumns ?? []);
  return {
    cover: {
      title: edits?.title ?? cover.title,
      dateline: edits?.dateline ?? cover.dateline,
      facts: cover.facts.map((fact) => ({ ...fact, v: facts.get(fact.k as CoverFactKey) ?? fact.v })),
    },
    summary: summary.map((row) => {
      const edited = { ...row };
      const override = rows.get(row.meetingId);
      for (const key of SUMMARY_COLUMN_KEYS) if (override?.[key] !== undefined) edited[key] = override[key]!;
      return edited;
    }),
    summaryColumns: SUMMARY_COLUMN_KEYS.filter((key) => !hidden.has(key)),
  };
}
