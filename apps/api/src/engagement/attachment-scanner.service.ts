/**
 * Attachment malware-scan abstraction (Phase 1 §3.h2).
 *
 * The application contract only. Phase 1 §6.1 is explicit that NO production
 * scanner or infrastructure contract was verified in this repository, and that
 * the executor must pause before provisioning one — so this file deliberately
 * ships:
 *
 *   - the `AttachmentScanner` interface and the status vocabulary;
 *   - a NULL adapter used when ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED=false, which
 *     reports `scanner_not_required` — NOT `clean`. That distinction is the whole
 *     point: `clean` is a security assertion about bytes, and no scanner has
 *     looked at these bytes. The UI must say "not scanned".
 *   - a test adapter for deterministic specs.
 *
 * It deliberately does NOT ship: an AWS GuardDuty / S3 object-tag adapter, any
 * CDK resource, or a "return clean" production default. Creating a fake clean
 * adapter would convert an unresolved infrastructure decision into a silent
 * false security guarantee, which is worse than the current honest gap.
 *
 * When a scanner IS chosen, add its adapter here and select it by configuration
 * — do not hardcode resource creation in application code.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';

/**
 * The scan lifecycle, mapped from whatever a provider reports.
 *
 *   pending        submitted / awaiting a verdict. NOT usable.
 *   clean          a real scanner inspected these bytes and found no threat.
 *   threat         malware found. Permanently unusable; never downloadable.
 *   unsupported    the scanner cannot inspect this type (e.g. encrypted zip).
 *   access_denied  the scanner could not read the object (IAM/KMS).
 *   failed         the scan errored. Retryable, but not usable meanwhile.
 *   scanner_not_required
 *                  no scanner is provisioned and the scan-required flag is off.
 *                  Usable in dev/test ONLY, and the UI must disclose it.
 */
export type AttachmentScanStatus =
  | 'pending'
  | 'clean'
  | 'threat'
  | 'unsupported'
  | 'access_denied'
  | 'failed'
  | 'scanner_not_required';

/** Statuses that permit extraction / context selection / download / send. */
const USABLE_SCAN_STATUSES: ReadonlySet<AttachmentScanStatus> = new Set<AttachmentScanStatus>([
  'clean',
  'scanner_not_required',
]);

/**
 * True when a scan status allows the bytes to be used. Note that
 * `scanner_not_required` is usable but MUST be disclosed — see
 * `scanStatusDisclosure`.
 */
export function isUsableScanStatus(status: AttachmentScanStatus | null | undefined): boolean {
  return status != null && USABLE_SCAN_STATUSES.has(status);
}

/** User-facing explanation for a non-usable (or undisclosed-risk) scan status. */
export function scanStatusDisclosure(status: AttachmentScanStatus | null): string | null {
  switch (status) {
    case 'clean':
      return null;
    case 'scanner_not_required':
      return 'This file was NOT virus-scanned (no scanner is configured in this environment).';
    case 'pending':
      return 'This file is still being scanned for malware. It cannot be used until the scan completes.';
    case 'threat':
      return 'This file was flagged as malware and cannot be used or sent.';
    case 'unsupported':
      return 'The malware scanner cannot inspect this file type, so it cannot be used.';
    case 'access_denied':
      return 'The malware scanner could not read this file. Re-upload it or contact your administrator.';
    case 'failed':
      return 'The malware scan failed. Retry the upload.';
    case null:
    default:
      // NULL = a pre-Phase-1 attachment that predates scanning entirely.
      return 'This file predates malware scanning and was never scanned.';
  }
}

export interface AttachmentScanner {
  /** The provider name recorded on the attachment row. */
  readonly providerName: string;
  getStatus(bucket: string, key: string): Promise<AttachmentScanStatus>;
}

/**
 * The adapter used while no scanner is provisioned.
 *
 * Reports `scanner_not_required` when ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED=false,
 * and `failed` when the flag is ON — because a deployment that REQUIRES scanning
 * with no scanner wired up must fail closed, not silently pass everything. That
 * is the fail-closed half of the flag; without it, flipping scan-required on
 * before the adapter exists would be indistinguishable from having a scanner.
 */
@Injectable()
export class NullAttachmentScanner implements AttachmentScanner {
  readonly providerName = 'none';
  private readonly logger = new Logger(NullAttachmentScanner.name);
  private warned = false;

  constructor(private readonly scanRequired: boolean) {}

  async getStatus(_bucket: string, _key: string): Promise<AttachmentScanStatus> {
    if (this.scanRequired) {
      if (!this.warned) {
        this.warned = true;
        this.logger.error(
          'ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED=true but no malware scanner adapter is configured — ' +
            'every attachment will report scan_status=failed and be unusable. Provision a scanner ' +
            '(Phase 1 §6.1) or set the flag back to false.',
        );
      }
      return 'failed';
    }
    return 'scanner_not_required';
  }
}

/** Deterministic adapter for specs: returns whatever the test queued per key. */
export class FakeAttachmentScanner implements AttachmentScanner {
  readonly providerName = 'fake';
  private readonly byKey = new Map<string, AttachmentScanStatus>();

  constructor(private readonly fallback: AttachmentScanStatus = 'clean') {}

  set(key: string, status: AttachmentScanStatus): this {
    this.byKey.set(key, status);
    return this;
  }

  async getStatus(_bucket: string, key: string): Promise<AttachmentScanStatus> {
    return this.byKey.get(key) ?? this.fallback;
  }
}

/**
 * Resolves the active scanner. One indirection so §6.1's decision (GuardDuty
 * Malware Protection for S3 / an internal ClamAV pipeline / another approved
 * scanner) lands here and nowhere else.
 */
@Injectable()
export class AttachmentScannerService {
  private readonly logger = new Logger(AttachmentScannerService.name);
  private readonly scanner: AttachmentScanner;
  readonly scanRequired: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    this.scanRequired = config.get('ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED', { infer: true });
    // Only the null adapter exists today, on purpose (§6.1). When a real adapter
    // is added, select it here by configuration.
    this.scanner = new NullAttachmentScanner(this.scanRequired);
  }

  get providerName(): string {
    return this.scanner.providerName;
  }

  /**
   * Current scan verdict for an object. Never throws: an adapter outage becomes
   * `failed` (not usable) rather than an exception that a caller might swallow
   * into "probably fine".
   */
  async getStatus(bucket: string, key: string): Promise<AttachmentScanStatus> {
    try {
      return await this.scanner.getStatus(bucket, key);
    } catch (e) {
      this.logger.warn(`attachment scan status lookup failed for ${key}: ${(e as Error).message}`);
      return 'failed';
    }
  }
}
