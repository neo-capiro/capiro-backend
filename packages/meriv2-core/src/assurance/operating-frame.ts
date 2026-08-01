import { createHash } from 'node:crypto';

export const GOVERNMENT_AFFAIRS_JURISDICTIONS = [
  'federal',
  'state',
  'local',
  'regulatory',
  'procurement',
  'grants',
] as const;

export type GovernmentAffairsJurisdiction = (typeof GOVERNMENT_AFFAIRS_JURISDICTIONS)[number];

export interface GovernmentAffairsOperatingFrame {
  jurisdictions: GovernmentAffairsJurisdiction[];
  stateCodes?: string[];
  institution?: string;
  chamber?: string;
  committeeOrAgency?: string;
  vehicleOrAccount?: string;
  fiscalYears?: number[];
  legislativeSession?: string;
  clientId?: string;
  clientObjective?: string;
  authorizedAsk?: string;
  targetAudience?: string[];
  timeHorizon?: { asOf: string; targetDate?: string };
  missingRequired: string[];
  assumptions: string[];
}

export interface ApprovedClientDirection {
  clientId?: string | null;
  objective?: string | null;
  authorizedAsk?: string | null;
  targetAudience?: string[] | null;
  /** Only approved/confirmed client steering may populate objective/ask fields. */
  approved: boolean;
}

export interface OperatingFrameInput {
  request: string;
  asOf?: string | Date;
  explicit?: Partial<GovernmentAffairsOperatingFrame>;
  approvedClientDirection?: ApprovedClientDirection | null;
  /** Server-resolved jurisdiction hints from authoritative records. */
  structuredJurisdictions?: readonly GovernmentAffairsJurisdiction[];
  structuredStateCodes?: readonly string[];
  structuredInstitution?: string | null;
  structuredCommitteeOrAgency?: string | null;
  structuredVehicleOrAccount?: string | null;
  structuredFiscalYears?: readonly number[];
  structuredLegislativeSession?: string | null;
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
};

const STATE_CODES = new Set(Object.values(STATE_NAMES));

const JURISDICTION_CUES: ReadonlyArray<{
  jurisdiction: GovernmentAffairsJurisdiction;
  re: RegExp;
}> = [
  {
    jurisdiction: 'federal',
    re: /\b(?:congress|u\.s\.\s+(?:house|senate)|house\s+(?:of\s+representatives|rule)|senate|federal\s+bill|h\.?r\.?\s*\d+|s\.?\s*\d+|ndaa|hac-?d|sac-?d|hasc|sasc|public\s+law|program\s+element|r-?1|p-?1)\b/i,
  },
  {
    jurisdiction: 'state',
    re: /\b(?:state\s+(?:bill|legislature|senate|house|assembly|register|agency|budget|appropriations?|funding|request)|general\s+assembly|governor|legiscan|openstates|session\s+\d{4})\b/i,
  },
  {
    jurisdiction: 'local',
    re: /\b(?:city\s+council|county\s+(?:commission|board)|municipal|mayor|zoning|local\s+ordinance|school\s+board)\b/i,
  },
  {
    jurisdiction: 'regulatory',
    re: /\b(?:regulation|rulemaking|proposed\s+rule|final\s+rule|notice\s+of\s+proposed|federal\s+register|state\s+register|docket|comment\s+(?:period|deadline)|effective\s+date|cfr)\b/i,
  },
  {
    jurisdiction: 'procurement',
    re: /\b(?:procurement|solicitation|request\s+for\s+proposals?|\brfp\b|\brfi\b|sam\.gov|contract\s+(?:award|vehicle)|cage\s+code|naics|psc\s+code|other\s+transaction|ota\b)\b/i,
  },
  {
    jurisdiction: 'grants',
    re: /\b(?:grants?\.gov|grant\s+(?:opportunity|award|application)|notice\s+of\s+funding|\bnofo\b|assistance\s+award|cooperative\s+agreement)\b/i,
  },
];

export function resolveGovernmentAffairsOperatingFrame(
  input: OperatingFrameInput,
): GovernmentAffairsOperatingFrame {
  const request = String(input.request ?? '').trim();
  const explicit = input.explicit ?? {};
  const jurisdictions = orderedUnique<GovernmentAffairsJurisdiction>([
    ...(explicit.jurisdictions ?? []),
    ...(input.structuredJurisdictions ?? []),
    ...JURISDICTION_CUES.filter((cue) => cue.re.test(request)).map((cue) => cue.jurisdiction),
  ]);

  const stateCodes = orderedUnique([
    ...(explicit.stateCodes ?? []),
    ...(input.structuredStateCodes ?? []),
    ...extractStateCodes(request),
  ]).map((code) => code.toUpperCase());

  // A named state tied to bill/legislature language is affirmative state evidence.
  if (
    stateCodes.length &&
    /\b(?:bill|legislat|assembly|senate|house|governor|state\s+agency|register)\b/i.test(request)
  ) {
    if (!jurisdictions.includes('state')) jurisdictions.push('state');
  }

  const fiscalYears = orderedUnique([
    ...(explicit.fiscalYears ?? []),
    ...(input.structuredFiscalYears ?? []),
    ...extractFiscalYears(request),
  ]).sort((a, b) => a - b);

  const approved = input.approvedClientDirection?.approved ? input.approvedClientDirection : null;
  const asOf = iso(input.asOf ?? new Date());
  const frame: GovernmentAffairsOperatingFrame = {
    jurisdictions,
    ...(stateCodes.length ? { stateCodes } : {}),
    ...(explicit.institution || input.structuredInstitution || inferInstitution(request)
      ? {
          institution:
            explicit.institution ??
            input.structuredInstitution ??
            inferInstitution(request) ??
            undefined,
        }
      : {}),
    ...(explicit.chamber || inferChamber(request)
      ? { chamber: explicit.chamber ?? inferChamber(request) ?? undefined }
      : {}),
    ...(explicit.committeeOrAgency ||
    input.structuredCommitteeOrAgency ||
    inferCommitteeOrAgency(request)
      ? {
          committeeOrAgency:
            explicit.committeeOrAgency ??
            input.structuredCommitteeOrAgency ??
            inferCommitteeOrAgency(request) ??
            undefined,
        }
      : {}),
    ...(explicit.vehicleOrAccount ||
    input.structuredVehicleOrAccount ||
    inferVehicleOrAccount(request)
      ? {
          vehicleOrAccount:
            explicit.vehicleOrAccount ??
            input.structuredVehicleOrAccount ??
            inferVehicleOrAccount(request) ??
            undefined,
        }
      : {}),
    ...(fiscalYears.length ? { fiscalYears } : {}),
    ...(explicit.legislativeSession || input.structuredLegislativeSession || inferSession(request)
      ? {
          legislativeSession:
            explicit.legislativeSession ??
            input.structuredLegislativeSession ??
            inferSession(request) ??
            undefined,
        }
      : {}),
    ...(explicit.clientId || approved?.clientId
      ? { clientId: explicit.clientId ?? approved?.clientId ?? undefined }
      : {}),
    ...(explicit.clientObjective || approved?.objective
      ? { clientObjective: explicit.clientObjective ?? approved?.objective ?? undefined }
      : {}),
    ...(explicit.authorizedAsk || approved?.authorizedAsk
      ? { authorizedAsk: explicit.authorizedAsk ?? approved?.authorizedAsk ?? undefined }
      : {}),
    ...(explicit.targetAudience?.length || approved?.targetAudience?.length
      ? { targetAudience: orderedUnique(explicit.targetAudience ?? approved?.targetAudience ?? []) }
      : {}),
    timeHorizon: {
      asOf,
      ...(explicit.timeHorizon?.targetDate
        ? { targetDate: iso(explicit.timeHorizon.targetDate) }
        : inferTargetDate(request)
          ? { targetDate: inferTargetDate(request)! }
          : {}),
    },
    missingRequired: [],
    assumptions: [...(explicit.assumptions ?? [])],
  };

  frame.missingRequired = requiredFrameGaps(frame, request);
  return frame;
}

export function requiredFrameGaps(
  frame: GovernmentAffairsOperatingFrame,
  request: string,
): string[] {
  const gaps: string[] = [];
  if (!frame.jurisdictions.length) gaps.push('jurisdiction');
  if (frame.jurisdictions.includes('state') && !frame.stateCodes?.length) gaps.push('stateCodes');
  if (frame.jurisdictions.includes('local') && !frame.institution) gaps.push('localInstitution');
  if (
    /\b(?:budget|funding|appropriat|authoriz|program\s+element|procurement\s+line)\b/i.test(
      request,
    ) &&
    !frame.fiscalYears?.length
  ) {
    gaps.push('fiscalYears');
  }
  if (/\b(?:recommend|strategy|who\s+should\s+we|advocacy|engage|ask\s+for)\b/i.test(request)) {
    if (!frame.clientObjective) gaps.push('clientObjective');
    if (!frame.authorizedAsk) gaps.push('authorizedAsk');
  }
  if (
    frame.jurisdictions.includes('regulatory') &&
    !frame.committeeOrAgency &&
    !frame.vehicleOrAccount
  ) {
    gaps.push('agencyOrDocket');
  }
  return orderedUnique(gaps);
}

export function operatingFrameTraceRef(
  frame: GovernmentAffairsOperatingFrame,
): Record<string, string> {
  const canonical = stableStringify(frame);
  return {
    operatingFrameVersion: 'ga-operating-frame-v1',
    operatingFrameHash: createHash('sha256').update(canonical).digest('hex'),
    operatingFrameJurisdictions: frame.jurisdictions.join(','),
    operatingFrameMissing: frame.missingRequired.join(','),
  };
}

function extractStateCodes(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(lower)) found.push(code);
  }
  for (const match of text.matchAll(/\b([A-Z]{2})\b/g)) {
    if (STATE_CODES.has(match[1]!)) found.push(match[1]!);
  }
  return orderedUnique(found);
}

function extractFiscalYears(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/\bFY\s*'?([0-9]{2}|20[0-9]{2})\b/gi)) {
    const raw = Number(match[1]);
    const fy = raw < 100 ? 2000 + raw : raw;
    if (fy >= 2000 && fy <= 2100) out.push(fy);
  }
  return orderedUnique(out);
}

function inferInstitution(text: string): string | null {
  if (/\bu\.s\.\s+house|house\s+of\s+representatives\b/i.test(text))
    return 'U.S. House of Representatives';
  if (/\bu\.s\.\s+senate|\bsenate\b/i.test(text)) return 'U.S. Senate';
  if (/\bcongress\b/i.test(text)) return 'U.S. Congress';
  const local = text.match(
    /\b([A-Z][A-Za-z .'-]{2,60})\s+(City Council|County Commission|County Board)\b/,
  );
  return local ? `${local[1]!.trim()} ${local[2]}` : null;
}

function inferChamber(text: string): string | null {
  if (/\b(?:house|assembly|lower\s+chamber)\b/i.test(text)) return 'lower';
  if (/\b(?:senate|upper\s+chamber)\b/i.test(text)) return 'upper';
  return null;
}

function inferCommitteeOrAgency(text: string): string | null {
  const committee = text.match(
    /\b((?:House|Senate|Joint|State)?\s*[A-Z][A-Za-z& ,.'-]{2,80}\s+(?:Committee|Subcommittee))\b/,
  );
  if (committee) return committee[1]!.trim();
  const agency = text.match(
    /\b((?:Department|Agency|Commission|Administration|Board|Bureau|Office)\s+of\s+[A-Z][A-Za-z& ,.'-]{2,80})\b/,
  );
  return agency?.[1]?.trim() ?? null;
}

function inferVehicleOrAccount(text: string): string | null {
  const patterns = [
    /\b(H\.?R\.?\s*\d+)\b/i,
    /\b(S\.?\s*\d+)\b/i,
    /\b((?:FY\s*'?\d{2,4}\s+)?NDAA)\b/i,
    /\b((?:defense\s+)?appropriations?(?:\s+bill)?)\b/i,
    /\b(PE\s*\d{7}[A-Z][A-Z0-9]*)\b/i,
    /\b(?:docket|RIN)\s*[:#]?\s*([A-Z0-9-]{4,40})\b/i,
    /\b(NOFO\s*[A-Z0-9-]{4,80})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1]!.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function inferSession(text: string): string | null {
  const match = text.match(
    /\b((?:20\d{2})(?:-20\d{2})?\s+(?:regular|special)?\s*session|\d{3}(?:st|nd|rd|th)\s+Congress)\b/i,
  );
  return match?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}

function inferTargetDate(text: string): string | null {
  const match = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return match?.[1] ? `${match[1]}T00:00:00.000Z` : null;
}

function orderedUnique<T>(values: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (value == null || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
