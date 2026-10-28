import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';

export type RecordData = Record<string, any>;
export const object = (v: unknown): RecordData => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordData : {};
export const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
export const numeric = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export function date(v: unknown): Date | undefined {
  const s = text(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : undefined;
}
export function noticeKey(v: unknown): string {
  const key = text(v)?.replace(/-/g, '').toLowerCase();
  if (!key || !/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid government notice identifier');
  return key;
}
export function samUrlKey(v: unknown): string {
  const url = new URL(String(v));
  if (url.protocol !== 'https:' || !['sam.gov', 'www.sam.gov'].includes(url.hostname)) throw new Error('Invalid SAM source URL');
  const match = /^\/opp\/([a-f\d-]+)\/view\/?$/i.exec(url.pathname);
  return noticeKey(match?.[1]);
}
// Tango appends this empty authentication parameter to the same SAM file ID.
// Match only the two verified forms, never strip meaningful query parameters.
export const SAM_FILE_URL_PATTERN = '^https://sam[.]gov/api/prod/opps/v3/opportunities/resources/files/[a-fA-F0-9]{32}/download(\\?&token=)?$';
export function samFileUrlAliases(url: string): string[] {
  if (!new RegExp(SAM_FILE_URL_PATTERN).test(url)) return [url];
  const base = url.replace(/\?&token=$/, '');
  return [base, `${base}?&token=`];
}
export function hash(v: string): string { return createHash('sha256').update(v).digest('hex'); }
export function searchText(body: string): string {
  const stripped = /<\/?[a-z][^>]*>/i.test(body)
    ? sanitizeHtml(body.replace(/<\/(?:p|div|li|tr|h[1-6])\s*>|<br\s*\/?>/gi, '\n'), { allowedTags: [], allowedAttributes: {} }) : body;
  const entities: Record<string,string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return stripped.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, value: string) => {
    if (!value.startsWith('#')) return entities[value.toLowerCase()] ?? whole;
    const number = value.startsWith('#x') ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return number >= 0xd800 && number <= 0xdfff ? '\ufffd'
      : number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
  }).replace(/\s+/g, ' ').trim();
}
/** Exact provider-label aliases only; no fuzzy eligibility inference. */
export function setAsideCode(label: string | undefined): string | null | undefined {
  if (!label) return undefined;
  const code = label.trim().toUpperCase();
  if (['SBA','SBP','8A','8AN','HZC','HZS','SDVOSBC','SDVOSBS','WOSB','WOSBSS','EDWOSB','EDWOSBSS','LAS','IEE','ISBEE','BICIV','VSA','VSS'].includes(code)) return code;
  const key = label.toLowerCase().replace(/\s*\(far[^)]*\)/g, '').replace(/[^a-z0-9]/g, '');
  const aliases: Record<string,string> = {
    totalsmallbusinesssetaside: 'SBA', partialsmallbusinesssetaside: 'SBP',
    '8asetaside': '8A', '8asolesource': '8AN', hubzonesetaside: 'HZC', hubzonesolesource: 'HZS',
    servicedisabledveteranownedsmallbusinesssetaside: 'SDVOSBC',
    servicedisabledveteranownedsmallbusinesssdvosbsetaside: 'SDVOSBC', sdvosbsolesource: 'SDVOSBS',
    womenownedsmallbusinesswosbprogramsetaside: 'WOSB', womenownedsmallbusinesssetaside: 'WOSB',
    wosbprogramsolesource: 'WOSBSS', economicallydisadvantagedwosbedwosbprogramsetaside: 'EDWOSB',
    economicallydisadvantagedwomenownedsmallbusinesssetaside: 'EDWOSB', edwosbprogramsolesource: 'EDWOSBSS',
    localareasetaside: 'LAS', indianeconomicenterpriseieesetaside: 'IEE',
    indiansmallbusinesseconomicenterpriseisbeesetaside: 'ISBEE', buyindiansetaside: 'BICIV',
    veteranownedsmallbusinesssetasideva: 'VSA', veteranownedsmallbusinesssolesourceva: 'VSS',
  };
  return aliases[key] || null;
}
export function stable(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function labels(v: unknown, field = 'description'): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(x => text(object(x)[field])).filter((x): x is string => !!x);
  return out.length ? out : undefined;
}
/** Omitted/empty enrichment never destroys useful legacy data. Explicit lifecycle
 * nulls are applied separately, only after the writer's timestamp comparison. */
export function grantFields(row: RecordData): RecordData {
  if (!/^\d+$/.test(String(row.grant_id)) || !text(row.title)) throw new Error('Unmappable grant');
  const org = object(row.organization), dates = object(row.important_dates), funding = object(row.funding_details);
  const statusCode = typeof row.status === 'string' ? row.status : object(row.status).code;
  const status = ({ P: 'posted', F: 'forecasted', C: 'closed', A: 'archived' } as Record<string, string>)[statusCode];
  if (!status) throw new Error('Unknown grant status');
  const synopsis = object(status === 'forecasted' ? row.forecast : row.synopsis);
  return compact({
    title: text(row.title), agency: text(org.department_name) ?? text(row.agency_code),
    subAgency: text(org.agency_name), opportunityNumber: text(row.opportunity_number),
    category: text(object(row.category).description), fundingInstrument: labels(row.funding_instruments)?.join('; '),
    eligibility: labels(row.applicant_types), cfdaNumbers: labels(row.cfda_numbers, 'number'),
    awardCeiling: numeric(funding.award_ceiling), awardFloor: numeric(funding.award_floor),
    estimatedFunding: numeric(funding.estimated_total_funding), expectedAwards: numeric(funding.expected_number_of_awards),
    openDate: date(dates.posted_date) ?? (status === 'forecasted' ? date(dates.estimated_synopsis_post_date) : undefined),
    closeDate: date(dates.response_date) ?? (status === 'forecasted' ? date(dates.estimated_application_response_date) : undefined), status,
    description: text(row.description), eligibilityText: text(row.applicant_eligibility_description),
    responseDateDesc: text(dates.response_date_description) ?? (status === 'forecasted' ? text(dates.estimated_application_response_date_description) : undefined), lastUpdatedAt: date(row.last_updated),
    docType: status === 'forecasted' ? 'forecast' : 'synopsis',
    costSharing: typeof synopsis.costSharing === 'boolean' ? synopsis.costSharing : undefined,
    revision: numeric(synopsis.version), url: `https://www.grants.gov/search-results-detail/${row.grant_id}`,
  });
}
export function noticeFields(row: RecordData): RecordData {
  const id = noticeKey(row.notice_id);
  if (row.sam_url && samUrlKey(row.sam_url) !== id) throw new Error('Conflicting government notice identifiers');
  if (!text(row.title)) throw new Error('Unmappable notice title');
  const office = object(row.office), type = object(object(row.meta).notice_type);
  // The existing varchar(32) column stores SAM's display vocabulary.
  const fullNoticeType = text(type.type);
  if (!fullNoticeType) throw new Error('Unmappable notice type');
  // Keep the existing SAM writer's varchar(32) display convention. The full
  // provider label and code remain available in the raw payload and snapshot.
  const noticeType = fullNoticeType.slice(0, 32);
  return compact({
    title: text(row.title), solicitationNumber: text(row.solicitation_number), noticeType,
    agency: text(office.department_name), subAgency: text(office.agency_name), office: text(office.office_name),
    description: text(row.description), naicsCode: row.naics_code != null ? String(row.naics_code) : undefined,
    pscCode: text(row.psc_code), setAside: text(row.set_aside), setAsideCode: setAsideCode(text(row.set_aside)),
    postedDate: date(row.posted_date), responseDeadline: date(row.response_deadline),
    placeOfPerformance: Object.keys(object(row.place_of_performance)).length ? row.place_of_performance : undefined,
    sourceUrl: `https://sam.gov/opp/${id}/view`, active: typeof row.active === 'boolean' ? row.active : undefined,
  });
}
export function compact(row: RecordData): RecordData { return Object.fromEntries(Object.entries(row).filter(([,v]) => v !== undefined)); }
/** UTF-16 offsets refer to normalized full text. No tail is silently discarded. */
export function chunks(body: string, size = 6000, overlap = 400): { text: string; start: number; end: number }[] {
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(overlap) || size < 2 || size <= overlap || overlap < 0 || size > 8000) throw new Error('Invalid chunk configuration');
  const normalized = body.replace(/\s+/g, ' ').trim();
  const result: { text: string; start: number; end: number }[] = [];
  const splitsCodePoint = (offset: number) => offset > 0 && offset < normalized.length
    && normalized.charCodeAt(offset - 1) >= 0xd800 && normalized.charCodeAt(offset - 1) <= 0xdbff
    && normalized.charCodeAt(offset) >= 0xdc00 && normalized.charCodeAt(offset) <= 0xdfff;
  for (let start = 0; start < normalized.length;) {
    let end = Math.min(start + size, normalized.length);
    // PDF font mappings can produce several tokens per character. Bound UTF-8
    // bytes as well as characters, leaving headroom below Titan's 8,192 tokens.
    // ASCII chunks retain their existing boundaries; no source text is dropped.
    if (Buffer.byteLength(normalized.slice(start, end), 'utf8') > 6000) {
      let low = start + 1, high = end;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(normalized.slice(start, mid), 'utf8') <= 6000) low = mid;
        else high = mid - 1;
      }
      end = low;
    }
    if (splitsCodePoint(end)) end--;
    result.push({ text: normalized.slice(start, end), start, end });
    if (end === normalized.length) break;
    start = Math.max(start + 1, end - overlap);
    if (splitsCodePoint(start)) start++;
  }
  return result;
}
