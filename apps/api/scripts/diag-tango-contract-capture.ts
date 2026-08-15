/**
 * Tango DIBBS + SBIR/STTR CONTRACT CAPTURE — the gate P40-P43 all inherit.
 *
 *   tsx scripts/diag-tango-contract-capture.ts --out <path>
 *
 * READ-ONLY. Five GETs, one small page each. Writes a single JSON artifact and
 * touches nothing else — no database, no writes, no mutation of any kind.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * P17's capability probe answered ENTITLEMENT and confirmed the pagination
 * ENVELOPE for both datasets. It captures no response bodies, so every field
 * TYPE, NULL SEMANTIC and DATE FORMAT across P40-P43 is still a reading of a
 * published field name. The schema, the mappers, the sync and the scorers were
 * all written against documentation.
 *
 * This captures the bodies, once, so those readings can be checked. It is the
 * "full contract validation" the completion matrix has listed as the real gate
 * since P40, and it is deliberately the SMALLEST thing that closes it.
 *
 * ── WHAT IT RECORDS, AND WHY IT IS NOT JUST THE RAW JSON ────────────────────
 *
 * Raw samples alone make a human diff field names by eye. So alongside the raw
 * records it emits a per-endpoint FIELD REPORT: for every field the contract
 * doc claims, whether it appeared, what JS types were observed, and how often
 * it was null. That turns "does the contract hold" into a table rather than a
 * reading exercise, and it is what makes the three specific failure modes
 * visible at a glance:
 *
 *   - a DOCUMENTED field that never appears  -> the doc is wrong, or the field
 *     is detail-endpoint-only. Mappers reading it silently produce null.
 *   - an UNDOCUMENTED field that does appear  -> the doc is incomplete, and we
 *     may be discarding something useful.
 *   - a field whose observed type is not what the column assumes -> the schema
 *     is wrong (e.g. a NUMERIC that arrives as a formatted string).
 *
 * ── THE KEY NEVER REACHES THIS FILE'S OUTPUT ────────────────────────────────
 *
 * The key is read from the environment, used only as an `X-API-KEY` header by
 * the clients, and never logged. Every error string is passed through both
 * redactors before it is written, because a provider that echoes the request
 * back in an error body is the one path by which a key could otherwise land in
 * an artifact. Per plan 4.6 the key must never pass through an agent session:
 * this script is run by an OPERATOR via operator/run-contract-capture.ps1,
 * which fetches from Secrets Manager and clears the variable in a finally.
 *
 * ── ONE PAGE, NOT A WALK ────────────────────────────────────────────────────
 *
 * Five requests total. P17 measured this account at 25 requests per ~31s, so a
 * capture fits comfortably inside one window with room for the probe. It is
 * deliberately NOT a paginated walk: the goal is the SHAPE of a record, and the
 * tenth page has the same shape as the first. A bigger sample would spend the
 * rate budget to learn nothing new.
 *
 * An endpoint that fails is RECORDED AND SKIPPED, never fatal — one dead
 * endpoint must not cost the other four, and a partial capture with the failure
 * named is strictly more useful than no capture.
 */
import { config as dotenvConfig } from 'dotenv';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  TangoDibbsClient,
  TangoDibbsEnvelopeError,
  TangoDibbsHttpError,
} from '../src/external/tango/tango-dibbs.client.js';
import {
  TangoSbirClient,
  TangoSbirEnvelopeError,
  TangoSbirHttpError,
} from '../src/external/tango/tango-sbir.client.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';

dotenvConfig();

/** Small on purpose — see the file doc. Enough rows to see a null vary. */
const SAMPLE_SIZE = 5;

/**
 * The fields `dibbs-sbir-rest-contract.md` claims each endpoint publishes.
 *
 * Transcribed from that document, NOT from the mappers. The point is to check
 * the document against reality — deriving this list from the mappers would only
 * prove the mappers agree with themselves.
 */
const DOCUMENTED_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // `solicitation_formatted` is deliberately ABSENT from this list. The
  // contract doc's own words are "List fields: ... Detail adds:
  // solicitation_formatted, organization(*)" — it is a DETAIL-endpoint field,
  // never present on a list response. Including it here was a bug in the
  // first version of this script (2026-08-09 capture): it made a field the
  // doc never promised on this endpoint report as "MISSING", which is not a
  // contract finding — it is this script disagreeing with its own source.
  'dibbs/rfqs': [
    'uuid', 'solicitation', 'purchase_request', 'nsn', 'part_number',
    'nomenclature', 'quantity', 'unit_of_issue', 'set_aside', 'status_code', 'issue_date',
    'return_by_date', 'is_open', 'document_url',
  ],
  'dibbs/rfps': [
    'uuid', 'solicitation', 'nsn', 'part_number', 'nomenclature', 'buyer_code', 'issued_date',
    'closes_date', 'is_open', 'document_url', 'tech_docs_url',
  ],
  // `total_contract_price_text` was MISSING from this list in the first
  // version of this script, despite the contract doc listing it explicitly
  // ("total_contract_price, total_contract_price_text, ..."). That produced a
  // false "UNDOCUMENTED present" finding on the 2026-08-09 capture — the field
  // was documented all along; this script's transcription was incomplete.
  'dibbs/awards': [
    'uuid', 'award_number', 'delivery_order_number', 'delivery_order_counter', 'solicitation',
    'purchase_request', 'nsn', 'part_number', 'nomenclature', 'total_contract_price',
    'total_contract_price_text', 'awardee_cage', 'awardee', 'award_date', 'posted_date',
    'last_mod_posting_date',
  ],
  'sbir/topics': [
    'topic_id', 'title', 'agency', 'year', 'topic_number', 'solicitation_number', 'release_date',
    'open_date', 'close_date', 'activity', 'solicitation_status', 'topic_url',
    'official_solicitation_url',
  ],
  'sbir/solicitations': [
    'solicitation_id', 'solicitation_number', 'title', 'program', 'cycle_name', 'year',
    'start_date', 'end_date', 'out_of_cycle', 'activity', 'solicitation_status',
    'sol_download_url',
  ],
});

interface FieldObservation {
  present: boolean;
  /** Every distinct JS type seen, so a field that is sometimes a string and sometimes a number shows both. */
  types: string[];
  nullCount: number;
  /** One real value, for eyeballing a date format. Truncated; never a whole record. */
  sample: string | null;
}

interface EndpointCapture {
  endpoint: string;
  ok: boolean;
  error: string | null;
  envelope: { keys: string[]; count: unknown; nextPresent: boolean } | null;
  recordCount: number;
  /** Documented fields, checked against what arrived. */
  documented: Record<string, FieldObservation>;
  /** Keys that ARRIVED but the contract doc does not mention. */
  undocumented: string[];
  rate: unknown;
  /** The raw records, verbatim. The ground truth everything else summarises. */
  raw: Array<Record<string, unknown>>;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function truncate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

/** Build the field report for one endpoint's sample. */
function describe(
  endpoint: string,
  records: Array<Record<string, unknown>>,
): Pick<EndpointCapture, 'documented' | 'undocumented'> {
  const documentedNames = DOCUMENTED_FIELDS[endpoint] ?? [];
  const documented: Record<string, FieldObservation> = {};

  for (const name of documentedNames) {
    const obs: FieldObservation = { present: false, types: [], nullCount: 0, sample: null };
    for (const record of records) {
      if (!(name in record)) continue;
      obs.present = true;
      const value = record[name];
      const t = typeOf(value);
      if (!obs.types.includes(t)) obs.types.push(t);
      if (value === null) obs.nullCount += 1;
      else if (obs.sample === null) obs.sample = truncate(value);
    }
    documented[name] = obs;
  }

  const seen = new Set<string>();
  for (const record of records) for (const key of Object.keys(record)) seen.add(key);
  const undocumented = [...seen].filter((key) => !documentedNames.includes(key)).sort();

  return { documented, undocumented };
}

async function captureOne(
  endpoint: string,
  fetchPage: () => Promise<{ items: Array<Record<string, unknown>>; totalCount: number | null; nextPage: number | null; rate: unknown }>,
  apiKey: string,
): Promise<EndpointCapture> {
  const base: EndpointCapture = {
    endpoint,
    ok: false,
    error: null,
    envelope: null,
    recordCount: 0,
    documented: {},
    undocumented: [],
    rate: null,
    raw: [],
  };

  try {
    const page = await fetchPage();
    const records = page.items;
    return {
      ...base,
      ok: true,
      envelope: {
        // The clients already assert `results` is an array and throw otherwise,
        // so reaching here IS the envelope confirmation. Recorded anyway so the
        // artifact stands alone without knowing that.
        keys: ['count', 'next', 'results'],
        count: page.totalCount,
        nextPresent: page.nextPage != null,
      },
      recordCount: records.length,
      ...describe(endpoint, records),
      rate: page.rate,
      raw: records,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind =
      error instanceof TangoDibbsEnvelopeError || error instanceof TangoSbirEnvelopeError
        ? 'ENVELOPE MISMATCH (contract update + fixture required; do NOT widen the client)'
        : error instanceof TangoDibbsHttpError || error instanceof TangoSbirHttpError
          ? `HTTP ${(error as { status: number }).status}`
          : 'unexpected';
    return {
      ...base,
      // Redacted twice: the key is known here, and the unknown-secret sweep
      // catches anything else the provider echoed back.
      error: `${kind}: ${redactWithKnownSecret(redact(message), apiKey)}`,
    };
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export async function main(): Promise<void> {
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('TANGO_CAPTURE_ERR No TANGO_API_KEY configured.');
    process.exitCode = 1;
    return;
  }

  const out = flagValue(process.argv.slice(2), 'out');
  if (!out) {
    console.error('TANGO_CAPTURE_ERR --out <path> is required.');
    process.exitCode = 1;
    return;
  }
  // Never clobber a capture. The same rule the P17 report follows: a captured
  // artifact is evidence, and the next run must not silently destroy it.
  if (existsSync(out)) {
    console.error(`TANGO_CAPTURE_ERR Refusing to overwrite an existing capture: ${out}`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.TANGO_API_BASE_URL;
  const dibbs = new TangoDibbsClient({ apiKey, baseUrl });
  const sbir = new TangoSbirClient({ apiKey, baseUrl });

  const captures: EndpointCapture[] = [];
  captures.push(await captureOne('dibbs/rfqs', () => dibbs.listRfqs({ limit: SAMPLE_SIZE }), apiKey));
  captures.push(await captureOne('dibbs/rfps', () => dibbs.listRfps({ limit: SAMPLE_SIZE }), apiKey));
  captures.push(await captureOne('dibbs/awards', () => dibbs.listAwards({ limit: SAMPLE_SIZE }), apiKey));
  captures.push(await captureOne('sbir/topics', () => sbir.listTopics({ limit: SAMPLE_SIZE }), apiKey));
  captures.push(
    await captureOne('sbir/solicitations', () => sbir.listSolicitations({ limit: SAMPLE_SIZE }), apiKey),
  );

  const artifact = {
    kind: 'tango-contract-capture',
    version: 1,
    generatedAt: new Date().toISOString(),
    sampleSize: SAMPLE_SIZE,
    requestsIssued: captures.length,
    note:
      'Field types, null semantics and date formats in P40-P43 were written against published ' +
      'field NAMES. This artifact is the first observation of the record CONTENTS. A mismatch is a ' +
      'contract-doc update plus a captured fixture, never a permissive fallback in a client or mapper.',
    endpoints: captures,
  };

  const dir = dirname(out);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(out, JSON.stringify(artifact, null, 2), 'utf8');

  // Human summary on stderr; the artifact path on stdout so a launcher can
  // capture it cleanly.
  for (const c of captures) {
    const missing = Object.entries(c.documented)
      .filter(([, o]) => !o.present)
      .map(([name]) => name);
    console.error(
      c.ok
        ? `  ${c.endpoint.padEnd(20)} ok  records=${c.recordCount}` +
            (missing.length ? `  MISSING documented fields: ${missing.join(', ')}` : '') +
            (c.undocumented.length ? `  UNDOCUMENTED present: ${c.undocumented.join(', ')}` : '')
        : `  ${c.endpoint.padEnd(20)} FAILED  ${c.error}`,
    );
  }
  console.log(out);
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /diag-tango-contract-capture(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      'TANGO_CAPTURE_ERR',
      redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null),
    );
    process.exitCode = 1;
  });
}
