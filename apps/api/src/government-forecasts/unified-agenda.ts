import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type ForecastEventType = 'proposed_rule' | 'final_rule';
export type ForecastPeriod =
  | { precision: 'month'; raw: string; year: number; month: number }
  | { precision: 'unknown'; raw: string };
export interface ForecastSource {
  edition: string;
  url: string;
  issuedAt: string | null;
  sha256: string;
}
export interface UnifiedAgendaCandidate {
  sourceKey: string;
  rin: string;
  title: string;
  eventType: ForecastEventType;
  period: ForecastPeriod;
  status: 'published';
  source: ForecastSource;
  confidence: 'not_supplied';
}
export interface UnifiedAgendaWithdrawal {
  rin: string;
  action: 'Withdrawn';
  rawDate: string;
  source: ForecastSource;
}
export interface UnifiedAgendaCompletion {
  sourceKey: string;
  rin: string;
  action: 'NPRM' | 'Final Rule';
  rawDate: string;
  source: ForecastSource;
}
export interface UnifiedAgendaResult {
  candidates: UnifiedAgendaCandidate[];
  withdrawnRins: UnifiedAgendaWithdrawal[];
  completedMilestones: UnifiedAgendaCompletion[];
  rejected: Array<{ rin: string | null; reason: string }>;
  sourceRunDate: string | null;
}
export interface UnifiedAgendaMetadata {
  /** Exact PUBLICATION_ID expected in every admitted row, not the current year. */
  edition: string;
  /** Verified publisher civil date (YYYY-MM-DD), never an inferred timestamp. RUN_DATE is not this. */
  issuedAt?: string | null;
}

const MAX_XML_BYTES = 40 * 1024 * 1024;
const MAX_RECORDS = 10_000;
type Row = Record<string, unknown>;
const object = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;
const array = (value: unknown): unknown[] =>
  value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string | null => (typeof value === 'string' ? value.trim() : null);
const actionType = (action: string): ForecastEventType | null =>
  action === 'NPRM' ? 'proposed_rule' : action === 'Final Rule' ? 'final_rule' : null;
const actionFamily = (action: string): ForecastEventType | null => {
  if (/comment|effective|withdraw/i.test(action)) return null;
  if (/\b(?:NPRM|FNPRM)\b/i.test(action)) return 'proposed_rule';
  if (/\bfinal (?:rule|action)\b/i.test(action)) return 'final_rule';
  return null;
};

function civilDate(raw: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const month = Number(mm),
    day = Number(dd),
    year = Number(yyyy);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1900 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]!
    ? `${yyyy}-${mm}-${dd}`
    : null;
}

function period(raw: string): ForecastPeriod | null {
  if (raw === 'To Be Determined' || raw === '00/00/0000') return { precision: 'unknown', raw };
  const match = /^(0[1-9]|1[0-2])\/00\/(\d{4})$/.exec(raw);
  if (!match || Number(match[2]) < 1900 || Number(match[2]) > 9998) return null;
  return { precision: 'month', raw, year: Number(match[2]), month: Number(match[1]) };
}

function sourceRunDay(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))?$/.test(raw))
    return null;
  const day = raw.slice(0, 10);
  return civilDate(`${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`) === day
    ? day
    : null;
}

/**
 * Pure publisher adapter. The adopted XML parser supplies XML validation/parsing;
 * this module supplies only Unified Agenda semantics. No clock, HTTP or DB effects.
 * Full-day timetable entries never become forecasts. Omission never withdraws one.
 */
export function parseUnifiedAgenda(
  xml: string,
  metadata: UnifiedAgendaMetadata,
): UnifiedAgendaResult {
  if (!/^\d{6}$/.test(metadata.edition) || Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES)
    throw new Error('Invalid Unified Agenda edition or oversized XML');
  if (
    metadata.issuedAt != null &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.issuedAt) ||
      civilDate(
        `${metadata.issuedAt.slice(5, 7)}/${metadata.issuedAt.slice(8, 10)}/${metadata.issuedAt.slice(0, 4)}`,
      ) !== metadata.issuedAt)
  )
    throw new Error('Publication issuedAt must be a verified civil date or null');
  // The publisher embeds HTML DOCTYPE text inside ABSTRACT CDATA. It is data,
  // not an XML declaration. Validate XML first, then reject actual DTD/entity
  // declarations outside literal CDATA/comments before enabling entity decoding.
  if (
    XMLValidator.validate(xml) !== true ||
    /<!DOCTYPE|<!ENTITY/i.test(
      xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, ''),
    )
  )
    throw new Error('Invalid or unsupported Unified Agenda XML');
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
  }).parse(xml);
  const document = object(parsed);
  const root = object(document?.REGINFO_RIN_DATA);
  if (!root) throw new Error('Missing REGINFO_RIN_DATA root');
  const entries = array(root.RIN_INFO);
  if (entries.length === 0 || entries.length > MAX_RECORDS)
    throw new Error('Invalid Unified Agenda record count');
  const result: UnifiedAgendaResult = {
    candidates: [],
    withdrawnRins: [],
    completedMilestones: [],
    rejected: [],
    sourceRunDate: text(root['@_RUN_DATE']),
  };
  const runDay = sourceRunDay(result.sourceRunDate);
  const sha256 = createHash('sha256').update(xml, 'utf8').digest('hex');
  const counts = new Map<string, number>();
  for (const value of entries) {
    const rin = text(object(value)?.RIN);
    if (rin) counts.set(rin, (counts.get(rin) ?? 0) + 1);
  }
  for (const value of entries) {
    const row = object(value),
      rin = text(row?.RIN),
      title = text(row?.RULE_TITLE);
    const reject = (reason: string) => result.rejected.push({ rin, reason });
    if (!row || !rin || !/^\d{4}-[A-Z0-9]{4}$/.test(rin) || !title || title.length > 2000) {
      reject('invalid_record');
      continue;
    }
    if (counts.get(rin) !== 1) {
      reject('duplicate_rin');
      continue;
    }
    if (text(object(row.PUBLICATION)?.PUBLICATION_ID) !== metadata.edition) {
      reject('edition_mismatch');
      continue;
    }
    const stage = text(row.RULE_STAGE);
    if (
      !stage ||
      ![
        'Prerule Stage',
        'Proposed Rule Stage',
        'Final Rule Stage',
        'Long-Term Actions',
        'Completed Actions',
      ].includes(stage)
    ) {
      reject('unsupported_rule_stage');
      continue;
    }
    const source: ForecastSource = {
      edition: metadata.edition,
      url: `https://www.reginfo.gov/public/do/eAgendaViewRule?pubId=${metadata.edition}&RIN=${encodeURIComponent(rin)}`,
      issuedAt: metadata.issuedAt ?? null,
      sha256,
    };
    const rawTimetable = array(object(row.TIMETABLE_LIST)?.TIMETABLE);
    if (rawTimetable.length > 500) {
      reject('oversized_timetable');
      continue;
    }
    const timetable = rawTimetable.map((value) => {
      const t = object(value);
      return {
        action: text(t?.TTBL_ACTION),
        date: text(t?.TTBL_DATE),
        citation: text(t?.FR_CITATION),
      };
    });
    if (
      timetable.some((t) => !t.action || !t.date || t.action.length > 300 || t.date.length > 100)
    ) {
      reject('invalid_timetable');
      continue;
    }
    const withdrawn = timetable.filter((t) => t.action === 'Withdrawn');
    if (withdrawn.length) {
      const date = withdrawn.length === 1 ? civilDate(withdrawn[0]!.date!) : null;
      const conflicting =
        !date ||
        timetable.some(
          (t) => t.action !== 'Withdrawn' && (!civilDate(t.date!) || civilDate(t.date!)! > date),
        );
      if (stage !== 'Completed Actions' || conflicting) {
        reject('ambiguous_withdrawal');
        continue;
      }
      if (!runDay) {
        reject('unverified_withdrawal_clock');
        continue;
      }
      if (date! > runDay) {
        reject('future_withdrawal');
        continue;
      }
      result.withdrawnRins.push({ rin, action: 'Withdrawn', rawDate: withdrawn[0]!.date!, source });
      // A later withdrawal of the rulemaking does not undo publication of an
      // earlier supported milestone. Preserve that evidence for the producer to
      // apply completions before withdrawal; Completed Actions cannot publish.
    }
    for (const eventType of ['proposed_rule', 'final_rule'] as const) {
      const family = timetable.filter((t) => actionFamily(t.action!) === eventType);
      if (family.length === 0) continue;
      // Earlier completed and later repeated milestones cannot safely share RIN+type.
      if (family.length !== 1) {
        reject(`ambiguous_${eventType}_milestone`);
        continue;
      }
      const milestone = family[0]!;
      if (actionType(milestone.action!) !== eventType) {
        reject(`unsupported_${eventType}_action`);
        continue;
      }
      const completedDay = civilDate(milestone.date!);
      if (completedDay) {
        if (!runDay) {
          reject(`unverified_${eventType}_completion_clock`);
          continue;
        }
        if (completedDay > runDay) {
          reject(`future_${eventType}_completion`);
          continue;
        }
        result.completedMilestones.push({
          sourceKey: `${rin}:${eventType}`,
          rin,
          action: milestone.action as 'NPRM' | 'Final Rule',
          rawDate: milestone.date!,
          source,
        });
        continue;
      }
      if (stage === 'Completed Actions') continue;
      const window = period(milestone.date!);
      if (!window || milestone.citation) {
        reject(`invalid_${eventType}_projection`);
        continue;
      }
      result.candidates.push({
        sourceKey: `${rin}:${eventType}`,
        rin,
        title,
        eventType,
        period: window,
        status: 'published',
        source,
        confidence: 'not_supplied',
      });
    }
  }
  return result;
}
