/**
 * Corpus source resolver — lets the ingestion CLI read its PDF corpus either from a
 * local directory/file (unchanged behaviour) OR from an `s3://bucket/prefix` location.
 *
 * WHY: the ingestion batch runs on a private-subnet Fargate task that cannot see the
 * operator workstation's filesystem. Staging the corpus to S3 and materializing it into
 * a local scratch dir at run time makes the batch fully cloud-native, idempotent, and
 * re-runnable — the rest of the pipeline (classify → archive → parse → extract) keeps
 * reading local files exactly as before.
 *
 * The S3 listing/filtering logic is pure and dependency-injected (CorpusS3) so it is
 * unit-testable with a fake client; only the CLI pulls in the real AWS SDK.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CorpusS3 {
  /** All object keys under `prefix` (recursive, paginated). */
  listKeys(bucket: string, prefix: string): Promise<string[]>;
  /** Raw bytes of a single object. */
  getObject(bucket: string, key: string): Promise<Uint8Array>;
}

export interface S3Location {
  bucket: string;
  prefix: string;
}

/** Parse an `s3://bucket/prefix` URI. Returns null for non-s3 targets. */
export function parseS3Uri(target: string): S3Location | null {
  if (!/^s3:\/\//i.test(target)) return null;
  const rest = target.replace(/^s3:\/\//i, '');
  const slash = rest.indexOf('/');
  if (slash === -1) {
    const bucket = rest.trim();
    if (!bucket) throw new Error(`Malformed s3 URI (no bucket): ${target}`);
    return { bucket, prefix: '' };
  }
  const bucket = rest.slice(0, slash).trim();
  const prefix = rest.slice(slash + 1);
  if (!bucket) throw new Error(`Malformed s3 URI (no bucket): ${target}`);
  return { bucket, prefix };
}

/** True if the object key names a PDF (case-insensitive), ignoring "directory" markers. */
export function isPdfKey(key: string): boolean {
  return /\.pdf$/i.test(key) && !key.endsWith('/');
}

/**
 * Materialize an s3://… corpus into a fresh local scratch directory and return its path.
 * Filenames are the object basenames (so the downstream filename classifier is unchanged).
 * Byte-identical basenames under the prefix would collide; we de-collide by prefixing a
 * short index, preserving the original basename suffix the classifier keys on.
 */
export async function materializeS3Corpus(
  loc: S3Location,
  s3: CorpusS3,
  opts: { destDir?: string } = {},
): Promise<{ dir: string; files: string[]; skipped: number }> {
  const keys = await s3.listKeys(loc.bucket, loc.prefix);
  const pdfKeys = keys.filter(isPdfKey);
  const skipped = keys.length - pdfKeys.length;

  const destDir = opts.destDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pe-corpus-'));
  fs.mkdirSync(destDir, { recursive: true });

  const usedNames = new Set<string>();
  const files: string[] = [];
  for (const key of pdfKeys) {
    let base = path.posix.basename(key);
    if (usedNames.has(base.toLowerCase())) {
      // Preserve the classifier-relevant basename; prefix a short disambiguator dir instead.
      const sub = fs.mkdtempSync(path.join(destDir, 'dup-'));
      const dest = path.join(sub, base);
      const bytes = await s3.getObject(loc.bucket, key);
      fs.writeFileSync(dest, Buffer.from(bytes));
      files.push(dest);
      continue;
    }
    usedNames.add(base.toLowerCase());
    const dest = path.join(destDir, base);
    const bytes = await s3.getObject(loc.bucket, key);
    fs.writeFileSync(dest, Buffer.from(bytes));
    files.push(dest);
  }
  return { dir: destDir, files, skipped };
}
