import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ALLOWED_MIME_TYPES,
  ATTACHMENT_FAILURES,
  ATTACHMENT_REFUSALS,
  DEFAULT_ATTACHMENT_POLICY,
  archiveKeyFor,
  checkAttachmentContent,
  checkAttachmentUrl,
  checkDecompressionRatio,
  contentDispositionFor,
  fetchAndArchiveAttachment,
  isRetryableFailure,
  normalizeMime,
  type ArchiveDeps,
  type AttachmentCandidate,
  type FetchedAttachment,
  type UrlCheck,
} from './opportunity-attachment.service.js';

/**
 * The attachment archive (P29).
 *
 * Nearly all of this file is about the four ways fetching an attacker-chosen
 * URL goes wrong — SSRF, redirect laundering, resource exhaustion, content
 * confusion. Each has its own block, and each block includes the case that
 * would defeat a naive version of the guard: the IPv4-mapped IPv6 address, the
 * redirect whose FIRST hop is fine, the 200-byte zip, the PDF that arrives as
 * HTML.
 */

const POLICY = DEFAULT_ATTACHMENT_POLICY;

function candidate(over: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return {
    id: 'att-1',
    sourceUrl: 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/abc/download',
    fileName: 'Solicitation.pdf',
    declaredMimeType: 'application/pdf',
    declaredSizeBytes: 120_000,
    ...over,
  };
}

const BODY = new TextEncoder().encode('%PDF-1.7 synthetic test document');
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');

function response(over: Partial<FetchedAttachment> = {}): FetchedAttachment {
  return {
    finalUrl: candidate().sourceUrl,
    status: 200,
    contentType: 'application/pdf',
    body: BODY,
    declaredLength: BODY.byteLength,
    uncompressedBytes: null,
    redirects: [],
    ...over,
  };
}

function makeDeps(
  over: {
    response?: FetchedAttachment;
    fetchThrows?: Error;
    exists?: boolean;
    putThrows?: boolean;
    hops?: string[];
  } = {},
) {
  const puts: Array<Record<string, unknown>> = [];
  const checked: string[] = [];
  const deps: ArchiveDeps = {
    transport: {
      fetch: async (url, checkHop, maxRedirects) => {
        checked.push(url);
        // A faithful transport double: it runs checkHop for EVERY hop, which is
        // the contract the real one has to honour.
        for (const hop of over.hops ?? []) {
          checked.push(hop);
          const verdict: UrlCheck = checkHop(hop);
          if (!verdict.ok) throw new Error(`${verdict.refusal}: ${verdict.detail}`);
        }
        if ((over.hops ?? []).length > maxRedirects) throw new Error('too_many_redirects: too many');
        if (over.fetchThrows) throw over.fetchThrows;
        return over.response ?? response();
      },
    },
    archive: {
      exists: async () => over.exists ?? false,
      put: async (input) => {
        if (over.putThrows) throw new Error('s3 unavailable');
        puts.push(input);
        return { versionId: 'v1' };
      },
    },
    bucket: 'capiro-dev-fo-attachments',
    prefix: 'opportunity-attachments',
  };
  return { deps, puts, checked };
}

// ── SSRF ─────────────────────────────────────────────────────────────────────

describe('SSRF: a URL Capiro did not choose cannot reach Capiro’s own network', () => {
  test.each([
    ['http://sam.gov/x', 'not_https'],
    ['ftp://sam.gov/x', 'not_https'],
    ['file:///etc/passwd', 'not_https'],
    ['not-a-url', 'not_https'],
  ])('%s is refused as %s', (url, refusal) => {
    // An allow-list of exactly ONE scheme. `file:`, `gopher:` and `data:` are
    // all things a URL string can be, and "not http" is not the same check.
    expect(checkAttachmentUrl(url, POLICY)).toMatchObject({ ok: false, refusal });
  });

  test.each([
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://10.0.0.5/x',
    'https://172.16.4.4/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'https://169.254.170.2/v2/credentials',
    'https://100.64.0.1/x',
    'https://[::1]/x',
    'https://db.internal/x',
    'https://printer.local/x',
  ])('%s is refused as a private-network host', (url) => {
    // 169.254.169.254 is the EC2 instance metadata service and 169.254.170.2
    // is the ECS task metadata endpoint. A fetch to either hands whoever chose
    // the URL a set of role credentials.
    expect(checkAttachmentUrl(url, POLICY)).toMatchObject({
      ok: false,
      refusal: 'private_network_host',
    });
  });

  test('an IPv4-mapped IPv6 address does NOT slip past the dotted-quad check', () => {
    // The same address wearing different notation. This test FOUND A REAL HOLE:
    // `new URL()` canonicalizes an IPv6 host to compressed HEX, so
    // `::ffff:169.254.169.254` arrives at the guard as `::ffff:a9fe:a9fe` and a
    // dotted-quad-only branch never matched it. With a non-empty allow-list the
    // request was still refused (as host_not_allowed), but with an empty one —
    // the documented "any public host" configuration — it would have reached
    // the EC2 metadata service.
    //
    // Both spellings are checked now, and the assertion is on the PRIVATE-HOST
    // refusal specifically, so the allow-list cannot mask a regression here.
    for (const url of ['https://[::ffff:169.254.169.254]/x', 'https://[::ffff:a9fe:a9fe]/x']) {
      expect(checkAttachmentUrl(url, POLICY)).toMatchObject({
        ok: false,
        refusal: 'private_network_host',
      });
      expect(checkAttachmentUrl(url, { ...POLICY, allowedHosts: new Set<string>() })).toMatchObject({
        ok: false,
        refusal: 'private_network_host',
      });
    }
  });

  test('credentials embedded in the URL are refused', () => {
    // https://sam.gov@evil.example/ reads as sam.gov to a careless human and
    // resolves to evil.example to every URL parser.
    expect(checkAttachmentUrl('https://sam.gov:tok@evil.example/x', POLICY)).toMatchObject({
      ok: false,
      refusal: 'url_has_credentials',
    });
  });

  test('a public host that is not on the allow-list is refused', () => {
    expect(checkAttachmentUrl('https://files.example.com/doc.pdf', POLICY)).toMatchObject({
      ok: false,
      refusal: 'host_not_allowed',
    });
  });

  test('an allow-listed host passes', () => {
    expect(checkAttachmentUrl('https://sam.gov/x/y.pdf', POLICY).ok).toBe(true);
    expect(checkAttachmentUrl('https://WWW.SAM.GOV/x/y.pdf', POLICY).ok).toBe(true);
  });

  test('an empty allow-list means any PUBLIC host, and still no private one', () => {
    const open = { ...POLICY, allowedHosts: new Set<string>() };
    expect(checkAttachmentUrl('https://files.example.com/doc.pdf', open).ok).toBe(true);
    expect(checkAttachmentUrl('https://169.254.169.254/x', open).ok).toBe(false);
  });
});

// ── Redirects ────────────────────────────────────────────────────────────────

describe('redirect laundering: every hop is checked, not just the first', () => {
  test('a redirect to a private host is REFUSED even though the first URL was fine', async () => {
    // The whole attack: the URL Capiro validates and the URL Capiro fetches are
    // not the same URL. Checking only the first is the same as not checking.
    const { deps } = makeDeps({ hops: ['https://169.254.169.254/latest/meta-data/'] });
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome).toMatchObject({ status: 'refused', failureReason: 'private_network_host' });
  });

  test('a redirect to an off-allow-list host is refused', async () => {
    const { deps } = makeDeps({ hops: ['https://evil.example/payload.pdf'] });
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome).toMatchObject({ status: 'refused', failureReason: 'host_not_allowed' });
  });

  test('an allowed redirect is followed', async () => {
    const { deps, checked } = makeDeps({ hops: ['https://www.sam.gov/real.pdf'] });
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome.status).toBe('archived');
    expect(checked).toContain('https://www.sam.gov/real.pdf');
  });

  test('too many redirects is a REFUSAL, not a failure', async () => {
    const { deps } = makeDeps({
      hops: ['https://sam.gov/1', 'https://sam.gov/2', 'https://sam.gov/3', 'https://sam.gov/4'],
    });
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome).toMatchObject({ status: 'refused', failureReason: 'too_many_redirects' });
  });
});

// ── Resource exhaustion ──────────────────────────────────────────────────────

describe('resource exhaustion: size and expansion are both bounded', () => {
  test('an oversized DECLARED length is refused BEFORE any request', async () => {
    // Refusing a 40 GB file after downloading it is not refusing it.
    const { deps, checked } = makeDeps();
    const outcome = await fetchAndArchiveAttachment(
      candidate({ declaredSizeBytes: 40 * 1024 * 1024 * 1024 }),
      deps,
    );
    expect(outcome).toMatchObject({ status: 'refused', failureReason: 'declared_size_over_limit' });
    expect(checked).toHaveLength(0);
  });

  test('an oversized OBSERVED body is a failure', async () => {
    const big = new Uint8Array(64);
    const { deps } = makeDeps({ response: response({ body: big, declaredLength: null }) });
    const outcome = await fetchAndArchiveAttachment(candidate(), {
      ...deps,
      policy: { ...POLICY, maxObservedBytes: 32 },
    });
    expect(outcome).toMatchObject({ status: 'failed', failureReason: 'observed_size_over_limit' });
  });

  test('a ZIP BOMB is caught by RATIO, which every size check on the compressed bytes misses', () => {
    // 200 bytes expanding to 40 GB passes any check applied to what arrived.
    expect(checkDecompressionRatio(200, 40 * 1024 * 1024 * 1024, POLICY).ok).toBe(false);
    // A well-compressed real document runs about 3:1 and is nowhere near.
    expect(checkDecompressionRatio(1_000_000, 3_000_000, POLICY).ok).toBe(true);
  });

  test('the ratio ceiling fires end-to-end for an archive, and only for an archive', async () => {
    const zip = makeDeps({
      response: response({
        contentType: 'application/zip',
        uncompressedBytes: 10_000_000_000,
        declaredLength: null,
      }),
    });
    const bomb = await fetchAndArchiveAttachment(
      candidate({ declaredMimeType: 'application/zip' }),
      zip.deps,
    );
    expect(bomb).toMatchObject({
      status: 'failed',
      failureReason: 'decompression_ratio_over_limit',
    });

    // A PDF has no expansion to measure. Applying a ratio to one would be
    // meaningless arithmetic dressed as a check.
    const pdf = makeDeps({ response: response({ uncompressedBytes: 10_000_000_000 }) });
    expect((await fetchAndArchiveAttachment(candidate(), pdf.deps)).status).toBe('archived');
  });

  test('a TRUNCATED body is a failure, never an archive', async () => {
    // Archiving a partial document stores it under a hash that will never
    // match the complete one, so every later citation of it is wrong.
    const { deps } = makeDeps({ response: response({ declaredLength: BODY.byteLength + 500 }) });
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome).toMatchObject({ status: 'failed', failureReason: 'truncated_body' });
  });

  test('an empty body is a failure, not a zero-byte archive', async () => {
    const { deps } = makeDeps({
      response: response({ body: new Uint8Array(0), declaredLength: null }),
    });
    expect(await fetchAndArchiveAttachment(candidate(), deps)).toMatchObject({
      status: 'failed',
      failureReason: 'empty_body',
    });
  });
});

// ── Content confusion ────────────────────────────────────────────────────────

describe('content confusion: the MIME allow-list is on what ARRIVED', () => {
  test('a disallowed observed type is refused', () => {
    expect(checkAttachmentContent(null, 'application/x-msdownload')).toMatchObject({
      ok: false,
      refusal: 'observed_mime_not_allowed',
    });
  });

  test('a PDF that ARRIVES as HTML is refused as a MISMATCH, not merely as a bad type', async () => {
    // Worth its own refusal: it says the URL is not serving the document it
    // claimed to, which is a finding even when the observed type is harmless.
    const { deps } = makeDeps({ response: response({ contentType: 'text/plain' }) });
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome).toMatchObject({ status: 'refused', failureReason: 'observed_mime_mismatch' });
  });

  test('a disallowed DECLARED type is refused before any request', async () => {
    const { deps, checked } = makeDeps();
    const outcome = await fetchAndArchiveAttachment(
      candidate({ declaredMimeType: 'application/x-sh' }),
      deps,
    );
    expect(outcome).toMatchObject({ status: 'refused', failureReason: 'declared_mime_not_allowed' });
    expect(checked).toHaveLength(0);
  });

  test('parameters and case do not defeat the allow-list', () => {
    expect(normalizeMime('Application/PDF; charset=UTF-8')).toBe('application/pdf');
    expect(checkAttachmentContent('application/pdf', 'Application/PDF; charset=UTF-8').ok).toBe(true);
  });

  test('the allow-list is an ALLOW-list — HTML and SVG are not on it', () => {
    // A deny-list is wrong the moment a new dangerous type exists. An
    // allow-list is wrong only by being too narrow, which is visible.
    expect(ALLOWED_MIME_TYPES.has('text/html')).toBe(false);
    expect(ALLOWED_MIME_TYPES.has('image/svg+xml')).toBe(false);
    expect(ALLOWED_MIME_TYPES.has('application/x-msdownload')).toBe(false);
    expect(ALLOWED_MIME_TYPES.has('application/pdf')).toBe(true);
  });

  test('EVERY type is delivered as a download, never inline', () => {
    // "This type is safe to render inline" is a judgement that goes stale, and
    // no reader in this program needs an inline render badly enough.
    for (const mime of ['application/pdf', 'text/plain', 'image/png']) {
      expect(contentDispositionFor(mime, 'x.pdf')).toMatch(/^attachment;/);
    }
  });

  test('a hostile filename cannot escape the Content-Disposition header', () => {
    // Every character outside [A-Za-z0-9._-] collapses to an underscore, so the
    // quote that would close the filename parameter and the semicolon that
    // would start a new one both disappear. The result is ugly and inert.
    const header = contentDispositionFor('application/pdf', '../../etc/passwd"; x="');
    expect(header).toBe('attachment; filename=".._.._etc_passwd_x_"');
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header.slice(header.indexOf('filename='))).not.toContain(';');
  });
});

// ── The archive key ──────────────────────────────────────────────────────────

describe('the archive key is the content hash, and that is the whole design', () => {
  test('identical bytes produce the identical key', () => {
    expect(archiveKeyFor('p', BODY_SHA)).toBe(archiveKeyFor('p', BODY_SHA));
  });

  test('CHANGED bytes produce a DIFFERENT key rather than overwriting', () => {
    // A requirement extracted from version A must still resolve to version A's
    // bytes after the agency posts version B. An overwriting key would
    // silently repoint the citation at text that does not contain the claim.
    const other = createHash('sha256').update('different').digest('hex');
    expect(archiveKeyFor('p', BODY_SHA)).not.toBe(archiveKeyFor('p', other));
  });

  test('the key carries no date, notice id or filename', () => {
    // Any of those would make the same bytes archive twice when one Q&A
    // document is attached to two notices, which happens constantly.
    const key = archiveKeyFor('opportunity-attachments', BODY_SHA);
    expect(key).toBe(
      `opportunity-attachments/${BODY_SHA.slice(0, 2)}/${BODY_SHA.slice(2, 4)}/${BODY_SHA}`,
    );
  });

  test('a malformed hash is refused rather than producing a garbage key', () => {
    expect(() => archiveKeyFor('p', 'nope')).toThrow(/SHA-256/);
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

describe('a healthy attachment archives, and a repeat is free', () => {
  test('it stores the bytes, the hash and the disposition', async () => {
    const { deps, puts } = makeDeps();
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome).toMatchObject({
      status: 'archived',
      contentSha256: BODY_SHA,
      observedSizeBytes: BODY.byteLength,
      observedMimeType: 'application/pdf',
      archiveBucket: 'capiro-dev-fo-attachments',
      deduplicated: false,
    });
    expect(puts[0]).toMatchObject({
      contentType: 'application/pdf',
      contentDisposition: 'attachment; filename="Solicitation.pdf"',
      contentSha256: BODY_SHA,
    });
  });

  test('an object already at the key is a NO-OP — nothing is uploaded or overwritten', async () => {
    // The key IS the hash, so an existing object there cannot be different
    // content. This is what makes re-archiving the same document free.
    const { deps, puts } = makeDeps({ exists: true });
    const outcome = await fetchAndArchiveAttachment(candidate(), deps);
    expect(outcome).toMatchObject({ status: 'archived', deduplicated: true });
    expect(puts).toHaveLength(0);
  });

  test('an archive write failure is a FAILURE, and the row is not marked archived', async () => {
    const { deps } = makeDeps({ putThrows: true });
    expect(await fetchAndArchiveAttachment(candidate(), deps)).toMatchObject({
      status: 'failed',
      failureReason: 'archive_write_failed',
    });
  });

  test('a non-2xx is a failure that names the status', async () => {
    const { deps } = makeDeps({ response: response({ status: 503 }) });
    expect(await fetchAndArchiveAttachment(candidate(), deps)).toMatchObject({
      status: 'failed',
      failureReason: 'http_error',
      failureDetail: 'The source returned HTTP 503.',
    });
  });

  test('a transport error is a failure, never a throw', async () => {
    // A throwing archive step would either abandon a whole sync run for one
    // hostile URL, or be wrapped in a catch that flattened refusals and
    // failures into one indistinguishable "error".
    const { deps } = makeDeps({ fetchThrows: new Error('ETIMEDOUT') });
    expect(await fetchAndArchiveAttachment(candidate(), deps)).toMatchObject({
      status: 'failed',
      failureReason: 'fetch_error',
    });
  });
});

describe('refused and failed are different, and only one is retried', () => {
  test('every refusal reason is NOT retryable, and every failure reason is', () => {
    // Retrying an SSRF attempt on a schedule is the attack working, slowly.
    for (const refusal of ATTACHMENT_REFUSALS) expect(isRetryableFailure(refusal)).toBe(false);
    for (const failure of ATTACHMENT_FAILURES) expect(isRetryableFailure(failure)).toBe(true);
  });

  test('the two vocabularies do not overlap', () => {
    const overlap = ATTACHMENT_REFUSALS.filter((r) =>
      (ATTACHMENT_FAILURES as readonly string[]).includes(r),
    );
    expect(overlap).toEqual([]);
  });
});

// ── Nothing leaks ────────────────────────────────────────────────────────────

describe('no attachment byte reaches a log, an audit row or an error', () => {
  const source = readFileSync(join(__dirname, 'opportunity-attachment.service.ts'), 'utf8');

  test('the service logs nothing at all', () => {
    expect(source).not.toMatch(/console\.(log|warn|error|info)/);
    expect(source).not.toMatch(/new Logger\(/);
  });

  test('no failure detail is built from the body', () => {
    // Every detail string is composed from the URL, the status, the sizes and
    // the MIME types — never from `body`. An injection payload inside a PDF
    // must not reach an operator's terminal either.
    // The check is on INTERPOLATION, not on the word: one detail legitimately
    // reads "returned a 2xx with no body", which is prose about the absence of
    // one rather than a quotation from it.
    const details = source.match(/failureDetail: [^,\n]+/g) ?? [];
    expect(details.length).toBeGreaterThan(5);
    for (const detail of details) {
      expect(detail).not.toMatch(/\$\{[^}]*\bbody\b[^}]*\}/);
      expect(detail).not.toMatch(/decode|toString\(\s*'utf/);
    }
  });

  test('the service never decodes the body as text', () => {
    expect(source).not.toMatch(/TextDecoder|body\.toString\(/);
  });
});

// ── The migration ────────────────────────────────────────────────────────────

describe('the database refuses a half-archived row', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260829010000_opportunity_attachments',
      'migration.sql',
    ),
    'utf8',
  );

  test('THE acceptance line: archived REQUIRES bucket, key, hash, size and time', () => {
    const chk = sql.match(/opportunity_attachment_archived_chk[\s\S]*?END \$\$;/)?.[0] ?? '';
    for (const column of [
      'archive_bucket',
      'archive_key',
      'content_sha256',
      'observed_size_bytes',
      'archived_at',
    ]) {
      expect(chk).toContain(`"${column}" IS NOT NULL`);
    }
  });

  test('a NON-archived row may carry no archive location', () => {
    // Otherwise a stale bucket/key from an earlier success makes a failed row
    // look citable.
    const chk = sql.match(/opportunity_attachment_unarchived_chk[\s\S]*?END \$\$;/)?.[0] ?? '';
    expect(chk).toContain('"archive_bucket" IS NULL');
    expect(chk).toContain('"archive_key" IS NULL');
  });

  test('a refusal or failure must say why', () => {
    const chk = sql.match(/opportunity_attachment_failure_chk[\s\S]*?END \$\$;/)?.[0] ?? '';
    expect(chk).toContain("'refused', 'failed'");
    expect(chk).toContain('"failure_reason" IS NOT NULL');
  });

  test('the status vocabulary is exactly the four', () => {
    const chk = sql.match(/opportunity_attachment_status_chk[\s\S]*?END \$\$;/)?.[0] ?? '';
    for (const status of ['metadata_only', 'archived', 'refused', 'failed']) {
      expect(chk).toContain(`'${status}'`);
    }
  });

  test('an attachment with no parent is refused', () => {
    const chk = sql.match(/opportunity_attachment_parent_chk[\s\S]*?END \$\$;/)?.[0] ?? '';
    expect(chk).toMatch(/sam_opportunity_id" IS NOT NULL OR "tango_notice_id" IS NOT NULL/);
  });

  test('the parent/url uniqueness COALESCEs, because NULLs are distinct in Postgres', () => {
    // A plain composite would admit unlimited duplicates for a notice-parented
    // row, whose sam_opportunity_id is null.
    expect(sql).toMatch(/COALESCE\("sam_opportunity_id"::text, ''\)/);
    expect(sql).toMatch(/COALESCE\("tango_notice_id", ''\)/);
  });

  test('the table is global, with no tenant_id, no RLS and no FK', () => {
    const create = sql.match(/CREATE TABLE IF NOT EXISTS "opportunity_attachment"[\s\S]*?\);/)?.[0] ?? '';
    expect(create).not.toMatch(/tenant_id/);
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/REFERENCES/i);
  });

  test('every statement is retry-safe', () => {
    expect(sql.match(/CREATE (TABLE|UNIQUE INDEX|INDEX)(?! IF NOT EXISTS)/g) ?? []).toEqual([]);
  });
});
