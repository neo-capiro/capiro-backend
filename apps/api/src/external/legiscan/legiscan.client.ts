/**
 * LegiScan Pull API client (State Legislation Platform, Phase 0 S1). LegiScan
 * is the bill spine (parent plan §S1/§2): `getMasterListRaw` returns every
 * bill in a session with a `change_hash` for cheap diffing; `getBill` carries
 * history/sponsors/votes/texts/sasts/calendar/supplements in one payload.
 *
 * Thin fetch wrapper mirroring apps/api/scripts/sync-house-votes.ts's
 * `fetchJson` (3 attempts, backoff, honors `retry-after` on 429/5xx). Every
 * call paces >=250ms apart — LegiScan sends no rate-limit headers, so quota
 * (not rate) is the binding constraint (self-accounted by callers via
 * `state_sync_cursor.queriesUsed`, S1.2). Always use the `id=` form of
 * `getMasterListRaw` — LegiScan's manual marks the `state=` form
 * "use with caution".
 *
 * API manual: https://legiscan.com/gaits/documentation/legiscan (v1.91,
 * verified against the Phase 0 implementation plan §2 S1.1).
 */

const LEGISCAN_BASE = 'https://api.legiscan.com/';
const PACE_MS = 250;

let lastCallAt = 0;
async function pace(): Promise<void> {
  const wait = lastCallAt + PACE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

interface LegiscanEnvelope {
  status?: string;
  alert?: { message?: string };
}

async function legiscanFetch<T>(
  apiKey: string,
  op: string,
  params: Record<string, string | number> = {},
  attempt = 1,
): Promise<T> {
  await pace();
  const url = new URL(LEGISCAN_BASE);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('op', op);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    if (attempt <= 3) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      return legiscanFetch<T>(apiKey, op, params, attempt + 1);
    }
    throw err;
  }
  if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
    const wait = Number(res.headers.get('retry-after') ?? String(attempt * 15)) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return legiscanFetch<T>(apiKey, op, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`LegiScan HTTP ${res.status} for op=${op}`);
  const body = (await res.json()) as LegiscanEnvelope & T;
  if (body.status && body.status !== 'OK') {
    const msg = body.alert?.message ? `: ${body.alert.message}` : '';
    throw new Error(`LegiScan op=${op} status=${body.status}${msg}`);
  }
  return body as T;
}

// ── getSessionList ──────────────────────────────────────────────────────────

export interface LegiscanSession {
  session_id: number;
  state_id?: number;
  year_start: number;
  year_end: number;
  session_name: string;
  session_tag?: string;
  special: 0 | 1;
  // NOT independently verified live (no LEGISCAN_API_KEY in this build
  // environment) whether LegiScan returns this as a 0/1 "has adjourned" flag
  // or an actual sine-die date string — handled defensively wherever
  // consumed (legiscan-normalize.ts `upsertStateSession`). CONFIRM against a
  // real getSessionList response in week 1 per the Phase 0 plan's own
  // validate-in-week-1 posture for LegiScan specifics.
  sine_die?: string | number | null;
  prior: 0 | 1;
  prefile?: 0 | 1;
}

export async function getSessionList(apiKey: string, state: string): Promise<LegiscanSession[]> {
  const body = await legiscanFetch<{ sessions?: LegiscanSession[] }>(apiKey, 'getSessionList', {
    state: state.toUpperCase(),
  });
  return body.sessions ?? [];
}

// ── getMasterListRaw ─────────────────────────────────────────────────────────

export interface LegiscanMasterlistBill {
  bill_id: number;
  number: string;
  change_hash: string;
  url?: string;
  status_date?: string | null;
  status?: number;
  last_action_date?: string | null;
  last_action?: string | null;
}

/** Always the `id=<session_id>` form — the `state=` form is "use with caution" per the manual. */
export async function getMasterListRaw(
  apiKey: string,
  sessionId: number,
): Promise<LegiscanMasterlistBill[]> {
  const body = await legiscanFetch<{ masterlist?: Record<string, unknown> }>(
    apiKey,
    'getMasterListRaw',
    { id: sessionId },
  );
  const raw = body.masterlist ?? {};
  const bills: LegiscanMasterlistBill[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'session') continue; // LegiScan embeds session metadata under this key
    const v = value as Partial<LegiscanMasterlistBill>;
    if (typeof v.bill_id === 'number' && typeof v.change_hash === 'string') {
      bills.push(v as LegiscanMasterlistBill);
    }
  }
  return bills;
}

// ── getBill ──────────────────────────────────────────────────────────────────

export interface LegiscanBillProgress {
  date: string;
  event: number;
}
export interface LegiscanBillHistory {
  date: string;
  action: string;
  chamber?: string;
  chamber_id?: number;
  importance?: number;
}
export interface LegiscanBillSponsor {
  people_id: number;
  name: string;
  first_name?: string;
  last_name?: string;
  party?: string;
  role?: string;
  sponsor_type_id: number; // 1 = primary
  sponsor_order?: number;
}
export interface LegiscanBillSast {
  type: string;
  type_id: number;
  sast_bill_number?: string;
  sast_bill_id?: number;
}
export interface LegiscanBillText {
  doc_id: number;
  date?: string | null;
  type: string;
  type_id?: number;
  mime?: string;
  mime_id?: number;
  url?: string;
  state_link?: string;
}
export interface LegiscanBillVoteStub {
  roll_call_id: number;
  date?: string;
  desc?: string;
  yea?: number;
  nay?: number;
  nv?: number;
  absent?: number;
  total?: number;
  passed?: number; // 0|1
  chamber?: string;
  chamber_id?: number;
  url?: string;
  state_link?: string;
}
export interface LegiscanBillCalendarEvent {
  type?: string;
  date?: string;
  time?: string;
  location?: string;
  description?: string;
}
export interface LegiscanBillCommittee {
  committee_id?: number;
  chamber?: string;
  name?: string;
}
export interface LegiscanBillAmendment {
  amendment_id: number;
  adopted?: 0 | 1;
  date?: string;
  title?: string;
  description?: string;
  chamber?: string;
  state_link?: string;
}
export interface LegiscanBill {
  bill_id: number;
  change_hash: string;
  session: LegiscanSession;
  url?: string;
  state_link?: string;
  number: string;
  bill_type?: string;
  body?: string;
  current_body?: string;
  title: string;
  description?: string;
  status: number;
  status_date?: string | null;
  progress?: LegiscanBillProgress[];
  history?: LegiscanBillHistory[];
  sponsors?: LegiscanBillSponsor[];
  sasts?: LegiscanBillSast[];
  subjects?: Array<{ subject_id?: number; subject_name?: string }>;
  texts?: LegiscanBillText[];
  votes?: LegiscanBillVoteStub[];
  calendar?: LegiscanBillCalendarEvent[];
  committee?: LegiscanBillCommittee;
  amendments?: LegiscanBillAmendment[];
}

export async function getBill(apiKey: string, billId: number): Promise<LegiscanBill | null> {
  const body = await legiscanFetch<{ bill?: LegiscanBill }>(apiKey, 'getBill', { id: billId });
  return body.bill ?? null;
}

// ── getRollCall ──────────────────────────────────────────────────────────────

export interface LegiscanRollCallVoteRow {
  people_id: number;
  vote_id?: number;
  vote_text: string; // 'Yea'|'Nay'|'NV'|'Absent'
}
export interface LegiscanRollCall {
  roll_call_id: number;
  bill_id?: number;
  date?: string;
  desc?: string;
  yea?: number;
  nay?: number;
  nv?: number;
  absent?: number;
  total?: number;
  passed?: number;
  chamber?: string;
  chamber_id?: number;
  votes?: LegiscanRollCallVoteRow[];
}

export async function getRollCall(
  apiKey: string,
  rollCallId: number,
): Promise<LegiscanRollCall | null> {
  const body = await legiscanFetch<{ roll_call?: LegiscanRollCall }>(apiKey, 'getRollCall', {
    id: rollCallId,
  });
  return body.roll_call ?? null;
}

// ── getDatasetList / getDataset (bulk backfill — ~2 queries/state) ─────────

export interface LegiscanDatasetListing {
  state_id?: number;
  session_id: number;
  session_name?: string;
  dataset_hash: string;
  dataset_date?: string;
  dataset_size?: number;
  access_key: string;
}
export async function getDatasetList(
  apiKey: string,
  state: string,
): Promise<LegiscanDatasetListing[]> {
  const body = await legiscanFetch<{ datasetlist?: LegiscanDatasetListing[] }>(
    apiKey,
    'getDatasetList',
    { state: state.toUpperCase() },
  );
  return body.datasetlist ?? [];
}

export interface LegiscanDataset {
  state_id?: number;
  session_id: number;
  dataset_hash: string;
  dataset_date?: string;
  mime_type?: string;
  zip: string; // base64-encoded ZIP
}
export async function getDataset(
  apiKey: string,
  sessionId: number,
  accessKey: string,
): Promise<LegiscanDataset | null> {
  const body = await legiscanFetch<{ dataset?: LegiscanDataset }>(apiKey, 'getDataset', {
    id: sessionId,
    access_key: accessKey,
  });
  return body.dataset ?? null;
}

// ── getSessionPeople ─────────────────────────────────────────────────────────

export interface LegiscanPerson {
  people_id: number;
  party_id?: string;
  party?: string;
  role_id?: number;
  role?: string;
  name: string;
  first_name?: string;
  last_name?: string;
  district?: string;
}
export async function getSessionPeople(
  apiKey: string,
  sessionId: number,
): Promise<LegiscanPerson[]> {
  const body = await legiscanFetch<{ sessionpeople?: { people?: LegiscanPerson[] } }>(
    apiKey,
    'getSessionPeople',
    { id: sessionId },
  );
  return body.sessionpeople?.people ?? [];
}
