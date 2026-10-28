import { createHash } from 'node:crypto';

/**
 * Fetching and archiving a federal solicitation attachment, safely (Funding
 * Opportunities P29).
 *
 * ── The threat model, stated because every rule below answers part of it ─────
 *
 * An attachment URL is a string that arrived from OUTSIDE Capiro. Following it
 * means making an HTTP request whose destination somebody else chose, and
 * storing whatever comes back. Four things can go wrong, and each has its own
 * guard here:
 *
 *   SSRF                 the URL points at Capiro's own network — the ECS task
 *                        metadata endpoint (169.254.170.2), the EC2 IMDS
 *                        (169.254.169.254), an RDS instance on a private
 *                        subnet, localhost. A fetch there exfiltrates
 *                        credentials to whoever chose the URL.
 *   REDIRECT LAUNDERING  the URL is fine and the 302 it returns is not. Every
 *                        hop is re-checked, because checking only the first is
 *                        the same as not checking.
 *   RESOURCE EXHAUSTION  a 40 GB file, or a 200-byte zip that expands to 40 GB.
 *                        Both are refused, the second by a decompression-ratio
 *                        ceiling rather than by a size check that only sees the
 *                        compressed bytes.
 *   CONTENT CONFUSION    a file served as `application/pdf` that is an HTML
 *                        page, or an executable. The MIME allow-list is on the
 *                        OBSERVED type, and a mismatch against the declared one
 *                        is itself a refusal.
 *
 * ── Refused is not the same as failed ────────────────────────────────────────
 *
 * A refusal is Capiro declining to go somewhere, and it must never be retried:
 * retrying an SSRF attempt on a schedule is the attack working, slowly. A
 * failure is a transient condition a later run should try again. The two are
 * separate statuses on `opportunity_attachment`, and
 * {@link isRetryableFailure} is the one place that says which is which.
 *
 * ── Nothing here logs a byte of the body ─────────────────────────────────────
 *
 * `failure_detail` is composed from the URL, the status code, the sizes and the
 * MIME types. There is no code path that puts file content into a log, an audit
 * row or an error message — an attachment is untrusted content, and a
 * prompt-injection payload in a PDF must not reach an operator's terminal
 * either.
 */

// ── Refusal and failure vocabularies ─────────────────────────────────────────

/**
 * Reasons Capiro declines to fetch, or declines to keep what it fetched.
 *
 * A REFUSAL is a decision about safety and is never retried.
 */
export const ATTACHMENT_REFUSALS = [
  'not_https',
  'url_has_credentials',
  'host_not_allowed',
  'private_network_host',
  'declared_size_over_limit',
  'declared_mime_not_allowed',
  'observed_mime_not_allowed',
  'observed_mime_mismatch',
  'too_many_redirects',
  'redirect_target_refused',
] as const;
export type AttachmentRefusal = (typeof ATTACHMENT_REFUSALS)[number];

/** Operational outcomes. A FAILURE may be retried by a later run. */
export const ATTACHMENT_FAILURES = [
  'fetch_error',
  'http_error',
  'empty_body',
  'truncated_body',
  'observed_size_over_limit',
  'decompression_ratio_over_limit',
  'checksum_mismatch',
  'archive_write_failed',
] as const;
export type AttachmentFailure = (typeof ATTACHMENT_FAILURES)[number];

export function isRetryableFailure(reason: string): boolean {
  return (ATTACHMENT_FAILURES as readonly string[]).includes(reason);
}

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * The MIME allow-list.
 *
 * An ALLOW-list, never a deny-list. A deny-list has to enumerate every
 * dangerous type and is wrong the moment a new one exists; an allow-list is
 * wrong only by being too narrow, which is a visible, fixable problem rather
 * than a silent hole.
 *
 * Archives are on the list because a solicitation's attachment set is routinely
 * a single .zip — but they get the decompression-ratio ceiling, which nothing
 * else needs.
 */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
  'application/rtf',
  'image/png',
  'image/jpeg',
  'image/tiff',
]);

/**
 * Types that must be delivered as a DOWNLOAD and never rendered inline.
 *
 * A browser rendering an attacker-authored HTML or SVG file from Capiro's own
 * origin is a stored XSS, and these two are the formats that reach a browser as
 * executable markup. They are not on the allow-list at all today — this set
 * exists so that if one is ever added, the delivery rule comes with it rather
 * than being remembered separately.
 */
export const NEVER_INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'image/svg+xml',
  'application/xhtml+xml',
]);

export interface AttachmentPolicy {
  /** Refused before any request when the source declares more than this. */
  maxDeclaredBytes: number;
  /** Failed mid-stream when the body exceeds this. */
  maxObservedBytes: number;
  /** Uncompressed:compressed. Above this, an archive is treated as a bomb. */
  maxDecompressionRatio: number;
  maxRedirects: number;
  /** Hosts a fetch may reach. Empty means "any public host". */
  allowedHosts: ReadonlySet<string>;
}

export const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = Object.freeze({
  // 200 MB. Larger than any real solicitation package observed, and small
  // enough that a pathological one cannot fill the task's disk.
  maxDeclaredBytes: 200 * 1024 * 1024,
  maxObservedBytes: 200 * 1024 * 1024,
  // 100:1. A well-compressed PDF-heavy zip runs about 3:1; a zip bomb runs
  // 1000:1 or more. The gap is wide enough that the ceiling never fires on a
  // real document.
  maxDecompressionRatio: 100,
  maxRedirects: 3,
  // SAM.gov's own attachment host and the provider's. Empty would mean "any
  // public host", which is a materially weaker posture — an agency that links
  // a document on a third-party site is a case for a reviewed addition here,
  // not for opening the fetch to the internet.
  // Exact SAM file redirect bucket observed in the dev archive canary; this
  // deliberately does not permit arbitrary S3 buckets.
  allowedHosts: new Set(['sam.gov', 'www.sam.gov', 'api.sam.gov', 'iae-fbo-attachments.s3.amazonaws.com', 'tango.makegov.com', 'tango.dev', 'www.grants.gov', 'api.grants.gov', 'apply07.grants.gov', 'sws.gsa.gov']),
});

// ── URL safety ───────────────────────────────────────────────────────────────

/** Every RFC1918/link-local/loopback range, plus the cloud metadata addresses. */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local, and the range BOTH the EC2 instance metadata
  // service (169.254.169.254) and the ECS task metadata endpoint
  // (169.254.170.2) live in. This is the single most valuable line here.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT. Not routable from the public internet either.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  /**
   * IPv4-mapped IPv6, in BOTH notations.
   *
   * `::ffff:169.254.169.254` is what an attacker types. `::ffff:a9fe:a9fe` is
   * what `new URL()` hands back for it — WHATWG URL parsing canonicalizes an
   * IPv6 host to compressed hex form, so the dotted-quad spelling never
   * survives to be matched. Checking only the readable form leaves the
   * metadata service reachable by the one spelling the parser actually
   * produces, which is the failure mode this branch exists for. (Found by the
   * test, not by review.)
   */
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isPrivateIPv4(dotted);
  }
  if (isPrivateIPv4(lower)) return true;
  // A bare `.internal`/`.local` name resolves inside a VPC and nowhere else.
  if (lower.endsWith('.internal') || lower.endsWith('.local')) return true;
  return false;
}

export interface UrlCheck {
  ok: boolean;
  refusal: AttachmentRefusal | null;
  detail: string | null;
}

const OK: UrlCheck = Object.freeze({ ok: true, refusal: null, detail: null });

/**
 * May Capiro fetch this URL?
 *
 * Applied to the ORIGINAL url and, unchanged, to EVERY redirect target. A guard
 * that runs only on the first URL is a guard an attacker moves past with one
 * 302.
 */
export function checkAttachmentUrl(raw: string, policy: AttachmentPolicy): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, refusal: 'not_https', detail: 'The attachment URL is not a valid URL.' };
  }

  if (url.protocol !== 'https:') {
    // Not merely "http is insecure": `file:`, `gopher:` and `data:` are all
    // things a URL string can be, and an allow-list of exactly one scheme is
    // the only form of this check that stays correct.
    return {
      ok: false,
      refusal: 'not_https',
      detail: `Refusing a non-HTTPS attachment URL (scheme "${url.protocol.replace(':', '')}").`,
    };
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in a URL would be sent to whatever host follows them, and
    // they are a classic way to make a hostile host look like a trusted one to
    // a careless reader (https://sam.gov@evil.example/).
    return {
      ok: false,
      refusal: 'url_has_credentials',
      detail: 'Refusing an attachment URL that embeds credentials.',
    };
  }

  if (isPrivateHost(url.hostname)) {
    return {
      ok: false,
      refusal: 'private_network_host',
      detail: `Refusing an attachment URL pointing at a private or link-local host (${url.hostname}).`,
    };
  }

  if (policy.allowedHosts.size > 0 && !policy.allowedHosts.has(url.hostname.toLowerCase())) {
    return {
      ok: false,
      refusal: 'host_not_allowed',
      detail: `Refusing an attachment URL on an unreviewed host (${url.hostname}).`,
    };
  }
  if (url.hostname === 'sws.gsa.gov' && (url.pathname !== '/sws-search/viewSolDocument.do' || (url.port && url.port !== '443'))) {
    return { ok: false, refusal: 'host_not_allowed', detail: 'Only the reviewed GSA solicitation document endpoint is allowed.' };
  }

  return OK;
}

// ── Content checks ───────────────────────────────────────────────────────────

/** Strip parameters and case from a Content-Type. `application/pdf; charset=x` -> `application/pdf`. */
export function normalizeMime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const base = value.split(';')[0]!.trim().toLowerCase();
  // Tango's attachment catalog sometimes sends an extension in mime_type.
  // Translate only known document formats; unknown values still fail closed.
  const extensions: Record<string, string> = {
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip', '.txt': 'text/plain', '.csv': 'text/csv',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.rtf': 'application/rtf',
  };
  if (extensions[base]) return extensions[base];
  if (base === 'text/rtf') return 'application/rtf';
  if (base === 'binary/octet-stream') return 'application/octet-stream';
  return base === '' ? null : base;
}

/** SAM sometimes serves documents as generic binary. Only recognize known
 * signatures, and retain the declared Office subtype when its container agrees.
 * Files remain downloads; this does not execute or unpack their contents. */
export function observedAttachmentMime(contentType: string | null, declaredType: string | null, bytes: Uint8Array): string | null {
  const observed = normalizeMime(contentType), declared = normalizeMime(declaredType);
  if (observed !== 'application/octet-stream') return observed;
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (bytes.length >= 8 && starts(37,80,68,70,45) && bytes[5]! >= 48 && bytes[5]! <= 57 && bytes[6] === 46 && bytes[7]! >= 48 && bytes[7]! <= 57) return 'application/pdf';
  if (starts(137,80,78,71,13,10,26,10)) return 'image/png';
  if (starts(255,216,255)) return 'image/jpeg';
  if (starts(73,73,42,0) || starts(77,77,0,42)) return 'image/tiff';
  if (starts(123,92,114,116,102) && bytes[5]! >= 48 && bytes[5]! <= 57) return 'application/rtf';
  if (starts(208,207,17,224,161,177,26,225) && declared &&
      ['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'].includes(declared)) return declared;
  if (starts(80,75,3,4) || starts(80,75,5,6)) {
    if (declared?.startsWith('application/vnd.openxmlformats-officedocument.') && ALLOWED_MIME_TYPES.has(declared)) return declared;
    return declared === 'application/x-zip-compressed' ? declared : 'application/zip';
  }
  // SAM also serves declared TXT/CSV documents as binary. Validate the full
  // body, not a prefix: malformed UTF-8, binary controls and HTML must not be
  // relabeled as plain text just because the catalog supplied an extension.
  if (declared === 'text/plain' || declared === 'text/csv') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/.test(text) &&
          !/<(?:!doctype\s+html|\/?(?:html|head|body|script|iframe|svg)\b)/i.test(text)) return declared;
    } catch { /* Unknown binary stays refused. */ }
  }
  return observed;
}

/**
 * Is what came back allowed, and is it what the source said it would be?
 *
 * The MISMATCH check is separate from the allow-list check, and both matter. A
 * file declared `application/pdf` that arrives as `text/html` is not merely a
 * disallowed type — it is a signal that the URL is not serving the document it
 * claimed to, which is worth refusing even when the observed type would
 * otherwise be fine.
 */
export function checkAttachmentContent(
  declaredMime: string | null,
  observedMime: string | null,
): UrlCheck {
  const normalizedDeclared = normalizeMime(declaredMime);
  // A generic declaration carries no format claim. The fetched response must
  // still resolve to an allowed type; unknown binary remains refused.
  const declared = normalizedDeclared === 'application/octet-stream' ? null : normalizedDeclared;
  const observed = normalizeMime(observedMime);

  if (observed != null && !ALLOWED_MIME_TYPES.has(observed)) {
    return {
      ok: false,
      refusal: 'observed_mime_not_allowed',
      detail: `Refusing content served as "${observed}"; it is not on the attachment allow-list.`,
    };
  }
  if (declared != null && !ALLOWED_MIME_TYPES.has(declared)) {
    return {
      ok: false,
      refusal: 'declared_mime_not_allowed',
      detail: `Refusing an attachment the source declares as "${declared}"; it is not on the allow-list.`,
    };
  }
  if (declared != null && observed != null && declared !== observed) {
    return {
      ok: false,
      refusal: 'observed_mime_mismatch',
      detail: `Refusing content served as "${observed}" when the source declared "${declared}".`,
    };
  }
  return OK;
}

/**
 * Is this archive a bomb?
 *
 * Ratio, not absolute size: a 200-byte zip expanding to 40 GB passes every size
 * check applied to the COMPRESSED bytes, which is the whole trick. Only called
 * for archive MIME types — a PDF has no expansion to measure, and applying a
 * ratio to one would be meaningless arithmetic dressed as a check.
 */
export function checkDecompressionRatio(
  compressedBytes: number,
  uncompressedBytes: number,
  policy: AttachmentPolicy,
): UrlCheck {
  if (compressedBytes <= 0) return OK;
  const ratio = uncompressedBytes / compressedBytes;
  if (ratio > policy.maxDecompressionRatio) {
    return {
      ok: false,
      refusal: null,
      detail: `Refusing an archive that expands ${Math.round(ratio)}:1, over the ${policy.maxDecompressionRatio}:1 ceiling.`,
    };
  }
  return OK;
}

export function isArchiveMime(mime: string | null): boolean {
  const m = normalizeMime(mime);
  return m === 'application/zip' || m === 'application/x-zip-compressed';
}

/** Risky formats are delivered as a download, never rendered in the page. */
export function contentDispositionFor(mime: string | null, fileName: string | null): string {
  const safeName = (fileName ?? 'attachment').replace(/[^\w.\-]+/g, '_').slice(0, 120);
  // ALWAYS `attachment`, for every type. The allow-list happens to exclude
  // HTML and SVG today, but "this type is safe to render inline" is a judgement
  // that goes stale, and there is no reader in this program that needs an
  // inline render badly enough to make it.
  return `attachment; filename="${safeName}"`;
}

// ── The archive key ──────────────────────────────────────────────────────────

/**
 * Where an attachment's bytes live, derived from the bytes themselves.
 *
 * CONTENT-ADDRESSED, and that is the whole design. Identical bytes produce the
 * identical key, so re-archiving is a free no-op; CHANGED bytes produce a
 * DIFFERENT key, so version A survives the agency posting version B. A
 * requirement P31 extracted from version A must still resolve to version A's
 * text — a key that overwrote would silently repoint a citation at a document
 * that does not contain the quoted claim.
 *
 * The hash is the whole path below the prefix. No date, no notice id, no
 * filename: every one of those would make the same bytes archive twice when
 * the same Q&A document is attached to two notices, which happens constantly.
 */
export function archiveKeyFor(prefix: string, contentSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new Error('archiveKeyFor requires a lowercase 64-character SHA-256.');
  }
  const clean = prefix.replace(/^\/+|\/+$/g, '');
  // Two levels of fan-out, so a bucket listing at any prefix stays navigable.
  return `${clean}/${contentSha256.slice(0, 2)}/${contentSha256.slice(2, 4)}/${contentSha256}`;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── The fetch/archive orchestration ──────────────────────────────────────────

export interface FetchedAttachment {
  /** Final URL after redirects. Every hop was checked. */
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** What the response actually delivered. */
  body: Uint8Array;
  /** The `Content-Length` header, when present. */
  declaredLength: number | null;
  /** Uncompressed size, for an archive the transport could measure. Null otherwise. */
  uncompressedBytes?: number | null;
  /** Redirect hops followed, in order. */
  redirects: string[];
}

export interface AttachmentTransport {
  /**
   * Fetch one URL, following redirects, and call `checkHop` for EVERY target
   * before following it. A transport that ignores `checkHop` fails the suite.
   */
  fetch(
    url: string,
    checkHop: (target: string) => UrlCheck,
    maxRedirects: number,
  ): Promise<FetchedAttachment>;
}

export interface ArchivePort {
  /** Returns the version id when the bucket is versioned, else null. */
  put(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
    contentDisposition: string;
    contentSha256: string;
  }): Promise<{ versionId: string | null }>;
  /** True when the key already holds identical bytes — a free no-op. */
  exists(bucket: string, key: string): Promise<boolean>;
}

export interface AttachmentCandidate {
  id: string;
  sourceUrl: string;
  fileName: string | null;
  declaredMimeType: string | null;
  declaredSizeBytes: number | null;
  /** Metadata version selected before the download; checked on publication. */
  sourceVersion?: string;
}

/** GSA SWS sends document roles in Tango's MIME field. Keep that raw field;
 * use the filename format only on the verified public download endpoint.
 * The fetched MIME and binary signature must still pass the normal checks. */
function hasGsaDocumentRole(candidate: AttachmentCandidate): boolean {
  const declared = normalizeMime(candidate.declaredMimeType);
  const url = new URL(candidate.sourceUrl);
  return url.hostname === 'sws.gsa.gov' && url.pathname === '/sws-search/viewSolDocument.do' &&
    ['solicitation','category attachment','sf30 attachment','regulations incorporated by reference','exhibit','other','vendor response document'].includes(declared ?? '');
}

function declaredAttachmentMime(candidate: AttachmentCandidate): string | null {
  if (hasGsaDocumentRole(candidate)) {
    return normalizeMime(candidate.fileName?.match(/\.[a-z0-9]+$/i)?.[0]);
  }
  return normalizeMime(candidate.declaredMimeType);
}

export type ArchiveOutcome =
  | {
      status: 'archived';
      contentSha256: string;
      observedSizeBytes: number;
      observedMimeType: string | null;
      archiveBucket: string;
      archiveKey: string;
      archiveVersionId: string | null;
      /** True when the key already existed — nothing was uploaded. */
      deduplicated: boolean;
    }
  | { status: 'refused'; failureReason: AttachmentRefusal; failureDetail: string }
  | { status: 'failed'; failureReason: AttachmentFailure; failureDetail: string };

export interface ArchiveDeps {
  transport: AttachmentTransport;
  archive: ArchivePort;
  bucket: string;
  prefix: string;
  policy?: AttachmentPolicy;
}

/**
 * Fetch one attachment and archive it, refusing or failing honestly.
 *
 * NEVER THROWS for a bad attachment. Every outcome is a value, because a
 * throwing archive step would either abandon a whole sync run for one hostile
 * URL or be wrapped in a catch that flattened refusals and failures into one
 * indistinguishable "error".
 */
export async function fetchAndArchiveAttachment(
  candidate: AttachmentCandidate,
  deps: ArchiveDeps,
): Promise<ArchiveOutcome> {
  const policy = deps.policy ?? DEFAULT_ATTACHMENT_POLICY;

  // ── 1. The URL, before anything is requested.
  const urlCheck = checkAttachmentUrl(candidate.sourceUrl, policy);
  if (!urlCheck.ok) {
    return { status: 'refused', failureReason: urlCheck.refusal!, failureDetail: urlCheck.detail! };
  }

  // ── 2. The DECLARED size, also before anything is requested. Refusing a
  // 40 GB file after downloading it is not refusing it.
  if (
    candidate.declaredSizeBytes != null &&
    candidate.declaredSizeBytes > policy.maxDeclaredBytes
  ) {
    return {
      status: 'refused',
      failureReason: 'declared_size_over_limit',
      failureDetail: `Refusing an attachment the source declares as ${candidate.declaredSizeBytes} bytes, over the ${policy.maxDeclaredBytes}-byte ceiling.`,
    };
  }

  const declaredMime = declaredAttachmentMime(candidate);
  if (declaredMime != null && declaredMime !== 'application/octet-stream' && !ALLOWED_MIME_TYPES.has(declaredMime)) {
    return {
      status: 'refused',
      failureReason: 'declared_mime_not_allowed',
      failureDetail: `Refusing an attachment the source declares as "${declaredMime}"; it is not on the allow-list.`,
    };
  }

  // ── 3. The fetch. EVERY redirect target goes through the same check.
  let response: FetchedAttachment;
  try {
    response = await deps.transport.fetch(
      candidate.sourceUrl,
      (target) => checkAttachmentUrl(target, policy),
      policy.maxRedirects,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A refusal thrown by the transport's own hop check stays a REFUSAL: it is
    // still Capiro declining to go somewhere, and retrying it on a schedule is
    // the attack working slowly.
    const refusal = (ATTACHMENT_REFUSALS as readonly string[]).find((r) => message.includes(r));
    if (refusal) {
      return {
        status: 'refused',
        failureReason: refusal as AttachmentRefusal,
        failureDetail: message,
      };
    }
    return { status: 'failed', failureReason: 'fetch_error', failureDetail: message };
  }

  if (response.redirects.length > policy.maxRedirects) {
    return {
      status: 'refused',
      failureReason: 'too_many_redirects',
      failureDetail: `Refusing after ${response.redirects.length} redirects, over the ${policy.maxRedirects} ceiling.`,
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      status: 'failed',
      failureReason: 'http_error',
      failureDetail: `The source returned HTTP ${response.status}.`,
    };
  }

  // ── 4. What actually arrived.
  const observedMime = observedAttachmentMime(response.contentType, declaredMime, response.body);
  // One verified GSA vendor-response document uses a .doc filename for RTF
  // bytes. Its provider field is a role, not a conflicting MIME declaration.
  // Keep ordinary MIME mismatches strict, including on other GSA formats.
  const checkedDeclaration = hasGsaDocumentRole(candidate) && declaredMime === 'application/msword' && observedMime === 'application/rtf'
    ? observedMime : declaredMime;
  const contentCheck = checkAttachmentContent(checkedDeclaration, observedMime);
  if (!contentCheck.ok) {
    return {
      status: 'refused',
      failureReason: contentCheck.refusal!,
      failureDetail: contentCheck.detail!,
    };
  }

  const size = response.body.byteLength;
  if (size === 0) {
    return {
      status: 'failed',
      failureReason: 'empty_body',
      failureDetail: 'The source returned a 2xx with no body.',
    };
  }
  if (size > policy.maxObservedBytes) {
    return {
      status: 'failed',
      failureReason: 'observed_size_over_limit',
      failureDetail: `The body was ${size} bytes, over the ${policy.maxObservedBytes}-byte ceiling.`,
    };
  }
  // A body SHORTER than the declared length is a truncated download, and
  // archiving it would store a partial document under a hash that will never
  // match the complete one. Counted as a FAILURE — the next run retries.
  if (response.declaredLength != null && size < response.declaredLength) {
    return {
      status: 'failed',
      failureReason: 'truncated_body',
      failureDetail: `The body was ${size} bytes; the source declared ${response.declaredLength}.`,
    };
  }

  if (isArchiveMime(observedMime) && response.uncompressedBytes != null) {
    const ratio = checkDecompressionRatio(size, response.uncompressedBytes, policy);
    if (!ratio.ok) {
      return {
        status: 'failed',
        failureReason: 'decompression_ratio_over_limit',
        failureDetail: ratio.detail!,
      };
    }
  }

  // ── 5. Archive, content-addressed.
  const contentSha256 = sha256Of(response.body);
  const key = archiveKeyFor(deps.prefix, contentSha256);

  try {
    // Identical bytes are already there. Nothing is uploaded and nothing is
    // overwritten — the key IS the hash, so an existing object at this key
    // cannot be different content.
    if (await deps.archive.exists(deps.bucket, key)) {
      return {
        status: 'archived',
        contentSha256,
        observedSizeBytes: size,
        observedMimeType: observedMime,
        archiveBucket: deps.bucket,
        archiveKey: key,
        archiveVersionId: null,
        deduplicated: true,
      };
    }

    const { versionId } = await deps.archive.put({
      bucket: deps.bucket,
      key,
      body: response.body,
      contentType: observedMime ?? 'application/octet-stream',
      contentDisposition: contentDispositionFor(observedMime, candidate.fileName),
      contentSha256,
    });

    return {
      status: 'archived',
      contentSha256,
      observedSizeBytes: size,
      observedMimeType: observedMime,
      archiveBucket: deps.bucket,
      archiveKey: key,
      archiveVersionId: versionId,
      deduplicated: false,
    };
  } catch (error) {
    return {
      status: 'failed',
      failureReason: 'archive_write_failed',
      failureDetail: error instanceof Error ? error.message : String(error),
    };
  }
}
