/**
 * Archive proof resolver.
 *
 * Uses the current archive metadata and S3 command wrappers to verify, when
 * the source was archived:
 *   - bucket, key, exact VersionId
 *   - exact object bytes or trusted checksum metadata
 *   - SHA against SourceDocument and artifact source SHA
 *   - byte size where known
 *   - Object Lock/versioning metadata where available
 *
 * Does not claim immutable archive proof from a nonempty bucket/key/version
 * string alone. For reviewed legacy artifacts whose source PDF is not
 * archived, returns `missing` and allows policy to determine REVIEW vs REJECT.
 */
import { sha256Bytes } from '../../contracts/canonical-json.js';
import type { TrustedArchiveProofV1, ProofFindingV1 } from './trusted-proof-types.js';
import { blockingFinding, reviewFinding } from './trusted-proof-types.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';

export interface ArchiveProofResolverInput {
  /** SourceDocument archive fields (nullable for legacy rows). */
  archiveBucket?: string | null;
  archiveS3Key?: string | null;
  archiveVersionId?: string | null;
  archiveKmsKeyArn?: string | null;
  retainUntil?: Date | null;
  archivedAt?: Date | null;
  /** Expected SHA (from source document or artifact). */
  expectedSourceSha256: string;
  /**
   * Policy: does this verification require an immutable archive?
   * When true, absence of archive metadata / VersionId / bytes is BLOCKING
   * (never a review-only finding). When false, absence may be review.
   */
  requireImmutableArchive?: boolean;
}

export interface S3ObjectReader {
  /** Read object bytes. Returns null if object not found. */
  getObjectBytes(bucket: string, key: string, versionId?: string): Promise<Buffer | null>;
  /** Head object metadata. Returns null if object not found. */
  headObject(bucket: string, key: string, versionId?: string): Promise<S3ObjectMetadata | null>;
}

export interface S3ObjectMetadata {
  contentLength?: number;
  sha256Checksum?: string;
  objectLockMode?: string;
  retainUntilDate?: string;
}

export interface ArchiveProofResolverResult {
  archive: TrustedArchiveProofV1;
  findings: ProofFindingV1[];
}

/**
 * Resolve archive proof from SourceDocument archive fields and S3.
 * Unit tests use a fake `S3ObjectReader`; production uses real S3.
 */
export class ArchiveProofResolver {
  constructor(private readonly s3Reader: S3ObjectReader) {}

  async resolve(input: ArchiveProofResolverInput): Promise<ArchiveProofResolverResult> {
    const required = input.requireImmutableArchive === true;
    // When the policy requires an immutable archive, any non-verified outcome
    // is a blocking finding (the policy table treats missing / not_applicable /
    // mismatch all as FAIL). When not required, absence may be review.
    const absenceFinding = required ? blockingFinding : reviewFinding;

    // If no archive metadata exists, the archive is absent.
    if (!input.archiveBucket || !input.archiveS3Key) {
      return {
        archive: { status: 'missing' },
        findings: [
          absenceFinding(
            'archive_version_missing',
            required
              ? 'policy requires immutable archive but source PDF has no archive metadata'
              : 'source PDF has no archive metadata; legacy artifact',
          ),
        ],
      };
    }

    // Require exact VersionId for immutable archive proof
    if (!input.archiveVersionId) {
      return {
        archive: { status: 'missing', bucket: input.archiveBucket, key: input.archiveS3Key },
        findings: [
          blockingFinding(
            'archive_version_missing',
            `archive bucket/key exist but VersionId is missing for ${input.archiveBucket}/${input.archiveS3Key}`,
          ),
        ],
      };
    }

    // Head the object to verify existence and get metadata
    const metadata = await this.s3Reader.headObject(
      input.archiveBucket,
      input.archiveS3Key,
      input.archiveVersionId,
    );

    if (!metadata) {
      return {
        archive: {
          status: 'missing',
          bucket: input.archiveBucket,
          key: input.archiveS3Key,
          versionId: input.archiveVersionId,
        },
        findings: [
          blockingFinding(
            'archive_sha_mismatch',
            `archived object not found at ${input.archiveBucket}/${input.archiveS3Key}@${input.archiveVersionId}`,
          ),
        ],
      };
    }

    // Verify SHA: prefer trusted checksum metadata, fall back to reading bytes
    let objectSha256: string | undefined;
    if (metadata.sha256Checksum) {
      objectSha256 = metadata.sha256Checksum;
    } else {
      // Read bytes and hash — R1: use sha256Bytes for raw object bytes
      const bytes = await this.s3Reader.getObjectBytes(
        input.archiveBucket,
        input.archiveS3Key,
        input.archiveVersionId,
      );
      if (bytes) {
        objectSha256 = sha256Bytes(bytes);
      }
    }

    if (!objectSha256) {
      return {
        archive: {
          status: 'mismatch',
          bucket: input.archiveBucket,
          key: input.archiveS3Key,
          versionId: input.archiveVersionId,
        },
        findings: [
          blockingFinding(
            'archive_sha_mismatch',
            `unable to compute or retrieve SHA for archived object ${input.archiveBucket}/${input.archiveS3Key}@${input.archiveVersionId}`,
          ),
        ],
      };
    }

    if (objectSha256 !== input.expectedSourceSha256) {
      return {
        archive: {
          status: 'mismatch',
          bucket: input.archiveBucket,
          key: input.archiveS3Key,
          versionId: input.archiveVersionId,
          objectSha256,
        },
        findings: [
          blockingFinding(
            'archive_sha_mismatch',
            `archive SHA ${objectSha256} does not match expected source SHA ${input.expectedSourceSha256}`,
          ),
        ],
      };
    }

    // Verified
    return {
      archive: {
        status: 'verified',
        bucket: input.archiveBucket,
        key: input.archiveS3Key,
        versionId: input.archiveVersionId,
        objectSha256,
        byteSize: metadata.contentLength,
        objectLockMode: metadata.objectLockMode,
        retainUntil: metadata.retainUntilDate,
        kmsKeyArn: input.archiveKmsKeyArn ?? undefined,
      },
      findings: [],
    };
  }
}

/**
 * R8.1 §2.5 — Evaluate a resolved archive proof against policy.
 *
 *   requireImmutableArchive = true
 *     verified       -> []           (PASS)
 *     missing        -> blocking FAIL
 *     mismatch       -> blocking FAIL
 *     not_applicable -> blocking FAIL
 *
 *   requireImmutableArchive = false
 *     verified       -> []           (PASS)
 *     missing        -> review (absence reviewable)
 *     not_applicable -> []           (SKIPPED)
 *     mismatch       -> blocking FAIL
 */
export function evaluateArchiveProofForPolicy(
  archive: TrustedArchiveProofV1,
  policy: Pick<VerificationPolicyV1, 'requireImmutableArchive'>,
): ProofFindingV1[] {
  if (policy.requireImmutableArchive) {
    if (archive.status === 'verified') return [];
    return [
      blockingFinding(
        archive.status === 'mismatch' ? 'archive_sha_mismatch' : 'archive_version_missing',
        `policy requires an immutable archive but archive proof status is "${archive.status}"`,
      ),
    ];
  }
  // Archive not required
  if (archive.status === 'verified' || archive.status === 'not_applicable') return [];
  if (archive.status === 'missing') {
    return [
      reviewFinding(
        'archive_version_missing',
        'archive not required by policy; archive absence is reviewable',
      ),
    ];
  }
  // mismatch
  return [
    blockingFinding(
      'archive_sha_mismatch',
      'archive bytes/metadata mismatch (blocking even when archive not required)',
    ),
  ];
}
